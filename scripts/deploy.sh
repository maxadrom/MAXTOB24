#!/usr/bin/env bash
#
# Идемпотентный деплой рабочего дерева MAX↔Б24 на боевой VPS (M12.8; порядок шагов — M26).
#
# Координаты VPS берутся из scripts/deploy.env (gitignored; шаблон — deploy.env.example).
# Корень дерева льётся БЕЗ `rsync --delete`: прод-`.env` и операторские бэкапы на VPS не трогаются.
# `--delete` — только по backends/ (контекст сборки образа, M26). Сироты вне backends/
# deploy лишь перечисляет — удалять их вручную. Локальный `.env` на VPS НЕ заливается — там
# живёт собственный боевой `.env`.
#
# Подкоманды:
#   deploy   (дефолт) — шаги деплоя (ниже); без APPLY=1 — только план.
#   pull-env          — забэкапить локальный .env.prod и затянуть боевой .env с VPS.
#
# Шаги deploy (M26). Каждый идемпотентен; после сбоя — повтор с упавшего шага: FROM=<шаг>.
#   sync     отчёт о сиротах, rsync рабочего дерева на VPS,   прод: прежний код
#            --delete по backends/
#   build    compose build api-node                           прод: прежний код
#   migrate  миграции в one-off `compose run --rm` на новом   прод: прежний код на новой схеме
#            образе — ДО пересоздания api                     (миграции только расширяющие)
#   up       пересоздать api на новом образе; старый процесс  прод: новый код
#            сперва дренирует очередь исходящих (до 3 мин).
#            Прерванный `compose up` прошлого запуска шаг ждёт
#            (после Ctrl+C он на VPS живёт дальше). Вывод compose
#            идёт через `tee -p` в UP_LOG на VPS: обрыв SSH не
#            обрывает пересоздание (M30)
#   health   до HEALTH_TRIES × HEALTH_DELAY с curl /health на VPS → "healthy" (каждая попытка
#            ограничена HEALTH_TIMEOUT: зависший ответ не вешает шаг)
#
# Режим деплоя:
#   DRY-RUN по умолчанию (ничего не пишет на VPS) — операция наружу.
#   Боевой запуск:  APPLY=1 scripts/deploy.sh
#   Догон:          APPLY=1 FROM=migrate scripts/deploy.sh   (make deploy APPLY=1 FROM=migrate)
#
# СЕКРЕТЫ И СОДЕРЖИМОЕ .env НИКОГДА НЕ ПЕЧАТАЕМ.

# -E (errtrace): шаги — функции, а без него ERR-trap внутри функций не срабатывает.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_ENV="$SCRIPT_DIR/deploy.env"

# --- Координаты VPS из scripts/deploy.env ------------------------------------
if [ ! -f "$DEPLOY_ENV" ]; then
  echo "❌ Не найден $DEPLOY_ENV"
  echo "   Создай его из шаблона и впиши реальные координаты VPS:"
  echo "     cp scripts/deploy.env.example scripts/deploy.env"
  exit 1
fi
# deploy.env под .gitignore (создаётся из deploy.env.example) — статанализатор его не видит.
# shellcheck source=scripts/deploy.env.example disable=SC1091
source "$DEPLOY_ENV"

# Дефолты для необязательных координат (если их нет в deploy.env).
REMOTE_HEALTH_URL="${REMOTE_HEALTH_URL:-127.0.0.1:5182/health}"
ENV_PROD="${ENV_PROD:-./.env.prod}"
APPLY="${APPLY:-0}"
FROM="${FROM:-sync}"

# Относительный ENV_PROD считаем от корня репо (устойчиво к CWD).
case "$ENV_PROD" in
  /*) : ;;
  *)  ENV_PROD="$ROOT_DIR/${ENV_PROD#./}" ;;
esac

# Обязательные координаты не должны быть пустыми/плейсхолдерами.
require_coord() {
  local name="$1" val="$2"
  if [ -z "$val" ] || [[ "$val" == __*__ ]]; then
    echo "❌ ${name} не задан или содержит плейсхолдер в scripts/deploy.env"
    echo "   Заполни реальными значениями (шаблон: scripts/deploy.env.example)."
    exit 1
  fi
}
require_coord VPS_USER "${VPS_USER:-}"
require_coord VPS_HOST "${VPS_HOST:-}"
require_coord VPS_PATH "${VPS_PATH:-}"

TARGET="${VPS_USER}@${VPS_HOST}"

# SSH-опции поверх ~/.ssh/config (опции командной строки сильнее): keepalive раз в 15 с,
# обрыв — после 20 пропущенных ответов, то есть 5 мин тишины. Короткий ServerAliveCountMax
# в ~/.ssh/config машины деплоя (например, 4 × 15 с) рвёт SSH посреди долгого шага на VPS.
SSH_OPTS=(-o ServerAliveInterval=15 -o ServerAliveCountMax=20 -o ConnectTimeout=20)
RSYNC_SSH="ssh ${SSH_OPTS[*]}"

# rsync-исключения. Зависимости/сборка идут ВНУТРИ Docker (pnpm install в контейнере),
# поэтому локальные артефакты не нужны. КЛЮЧЕВОЕ отличие от старого скрипта:
#   - корень — БЕЗ `--delete` (не сносим прод-.env и бэкапы на VPS);
#   - явно исключаем .env / .env.* / backup_*.sql, чтобы НЕ затереть боевой конфиг и дампы.
# Исключённое не удаляется и под `--delete` по backends/: без --delete-excluded rsync его не трогает.
RSYNC_EXCLUDES=(
  --exclude '.env'
  --exclude '.env.*'
  --exclude 'backup_*.sql'
  # Локальные координаты VPS: имя deploy.env под паттерн .env.* НЕ попадает (как и в .gitignore).
  --exclude 'scripts/deploy.env'
  --exclude node_modules
  --exclude .pnpm-store
  --exclude .git
  --exclude logs
  --exclude .output
  --exclude .nuxt
  # Dev-кухня (AI-контекст/навыки/планы/аудиты) — gitignored, приложению не нужна, на прод не шлём.
  --exclude .ai-factory
  --exclude .ai-factory.json
  --exclude .claude
  --exclude .cursor
  # Локальный конфиг MCP-серверов (gitignored, содержит токены) — на прод не шлём.
  --exclude .mcp.json
  # Локальный compose-override dev-машины (напр. порты только на 127.0.0.1) — прод его
  # не читает (запуск с явными -f), но и мусор на VPS не нужен.
  --exclude docker-compose.override.yml
)

# Команды docker compose на VPS (prod-профили + prod-override).
REMOTE_COMPOSE='COMPOSE_PROFILES=node,db-postgres BUILD_TARGET=production docker compose -f docker-compose.yml -f docker-compose.server.yml'

# Health после пересоздания api: старт занимает секунды (замер M29: 6,1 с с `CMD pnpm`,
# ~1 с с `node server.js`), поэтому повторяем.
HEALTH_TRIES=20
HEALTH_DELAY=3
# Предел одной попытки, с (curl --max-time; соединение — до 3 с). Без него curl ждёт ответа
# бесконечно: процесс, принявший соединение и не отвечающий, подвесил бы шаг без on_err —
# SSH при этом жив (ServerAlive). Весь шаг — не дольше HEALTH_TRIES × (HEALTH_TIMEOUT + HEALTH_DELAY).
HEALTH_TIMEOUT=5
# Ожидание прерванного `compose up` перед шагом up: до PREV_UP_TRIES × PREV_UP_DELAY с — больше
# stop_grace_period (180 с), за который Docker в любом случае добьёт старый api.
PREV_UP_TRIES=40
PREV_UP_DELAY=5
# Полный вывод `compose up` шага up на VPS (M30). В домашнем каталоге пользователя деплоя: вне
# проекта (не попадёт в отчёт о сиротах) и не в общем /tmp, где чужой файл с тем же именем tee не
# откроет (fs.protected_regular) — и защита от обрыва SSH не сработала бы. `~` раскрывает шелл VPS.
# Прежний вывод перед запуском уходит в UP_LOG.prev: догон FROM=up не затирает итог прерванного.
# shellcheck disable=SC2088  # тильда намеренно в кавычках: раскрывает её шелл VPS, а не клиент
UP_LOG='~/maxtob24-deploy-up.log'

STEPS=(sync build migrate up health)
RUN_STEPS=()
CURRENT_STEP=''

# --- Команда на VPS ----------------------------------------------------------
# Исполняется в каталоге проекта. Не `cd … && $*`: команда шага бывает списком `a | b || c`,
# и при `&&` упавший cd запустил бы `c` не в том каталоге. 97 — каталога VPS_PATH нет.
remote() {
  # VPS_PATH и команда раскрываются на клиенте намеренно: это локальный конфиг, исполняет VPS.
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$TARGET" "cd '${VPS_PATH}' || exit 97; $*"
}

# --- Сбой и Ctrl+C: какой шаг, что на проде, как догнать ----------------------
# $1 — код выхода: 255 (SSH), 130 (Ctrl+C), 143 (TERM) — прерывание, остальное — сбой команды.
resume_hint() {
  [ -n "$CURRENT_STEP" ] || return 0
  local code="${1:-0}"
  case "$CURRENT_STEP" in
    sync|build)
      echo "   На VPS работает прежний код: api не пересоздавался." ;;
    migrate)
      echo "   На VPS работает прежний код. Миграции, применённые до сбоя, остаются (каждая — в своей"
      echo "   транзакции). После обрыва SSH one-off контейнер дорабатывает сам: повтор подождёт его"
      echo "   на advisory lock и не применит миграцию дважды." ;;
    up)
      case "$code" in
        255|130|143)
          echo "   Прерванный compose up на VPS доводит пересоздание до конца: ssh без pty его не гасит, а вывод"
          echo "   идёт через tee -p в ${UP_LOG} на VPS (там и итог; после FROM=up — в .prev)."
          echo "   FROM=up сначала дождётся его выхода." ;;
        *)
          echo "   compose up завершился ошибкой (код ${code}); его вывод — выше и в ${UP_LOG} на VPS." ;;
      esac
      echo "   Руками на VPS — только после его выхода (pgrep -a -x docker-compose — без «up»), иначе"
      echo "   гонка за временный контейнер <id>_api. Затем docker ps -a --filter name=api:"
      echo "   api Up на новом образе → FROM=health; api Created/Exited или его нет → FROM=up;"
      echo "   остался дубль <id>_api — docker rm его, затем FROM=up." ;;
    health)
      echo "   api пересоздан на новом образе, но \"healthy\" не получен: смотрите docker logs api на VPS."
      echo "   Откат — прежний тег образа и FROM=up (docs/deploy/vps-prod.md §4)." ;;
  esac
  echo "   Догнать с этого шага: make deploy APPLY=1 FROM=${CURRENT_STEP}"
}

on_err() {
  local code="$1"
  # ERR-trap наследуют и подоболочки (-E): печатает только основной процесс.
  if [ "${BASH_SUBSHELL:-0}" -gt 0 ]; then return 0; fi
  trap - ERR INT TERM
  echo "❌ Сбой${CURRENT_STEP:+ на шаге «${CURRENT_STEP}»} (код ${code})."
  case "$code" in
    97)  echo "   На VPS нет каталога ${VPS_PATH} (VPS_PATH в scripts/deploy.env)." ;;
    96)  echo "   На VPS всё ещё работает прежний compose up (pgrep -a -x docker-compose)." ;;
    255) echo "   Код 255 — обычно сбой SSH: соединение не установлено или оборвалось." ;;
  esac
  resume_hint "$code"
  exit "$code"
}

# Прерывание сигналом: $1 — как назвать сигнал, $2 — код выхода (130 Ctrl+C, 143 TERM).
on_signal() {
  trap - ERR INT TERM
  echo
  echo "⚠️  Прервано ${1}${CURRENT_STEP:+ на шаге «${CURRENT_STEP}»}."
  resume_hint "$2"
  exit "$2"
}

# M30: SIGTERM — таймаут или kill инструмента, запустившего деплой (агент, CI). Без ловушки
# скрипт умер бы молча, без шага и команды догона. TERM всей группе (timeout, агент) обрывает
# и ssh — подсказка сразу; TERM одному bash ловушка ждёт до конца текущей удалённой команды.
# HUP не ловим: терминал закрыт, подсказку никто не увидит.
trap 'on_err $?' ERR
trap 'on_signal "(Ctrl+C)" 130' INT
trap 'on_signal "сигналом TERM" 143' TERM

# --- Шаги деплоя -------------------------------------------------------------
step_desc() {
  case "$1" in
    sync)    echo "отчёт о сиротах; rsync рабочего дерева → VPS (корень БЕЗ --delete), --delete по backends/" ;;
    build)   echo "compose build api-node (прод — на прежнем образе)" ;;
    migrate) echo "миграции в one-off compose run --rm на новом образе, до пересоздания api" ;;
    up)      echo "дождаться прерванного compose up прошлого запуска, если он ещё идёт; compose up -d --no-deps --no-build api-node (пересоздание на новом образе; ждёт дренажа очереди старого процесса, до 3 мин)" ;;
    health)  echo "curl http://${REMOTE_HEALTH_URL} на VPS до ${HEALTH_TRIES} раз через ${HEALTH_DELAY} с (попытка ≤ ${HEALTH_TIMEOUT} с) → \"healthy\"" ;;
  esac
}

# Предпросмотр rsync всего дерева с --delete (-n: на VPS ничего не пишет). Строки `*deleting` —
# файлы VPS, которых нет в рабочем дереве (сироты); остальное — план изменений.
rsync_preview() {
  rsync -azn --delete --itemize-changes -e "$RSYNC_SSH" "${RSYNC_EXCLUDES[@]}" "$ROOT_DIR/" "${TARGET}:${VPS_PATH}"
}

# Сироты из вывода rsync_preview ($1) двумя группами: backends/ удаляет sync, остальное — вручную.
report_orphans() {
  local orphans in_backends outside
  orphans="$(printf '%s\n' "$1" | sed -n 's/^\*deleting  *//p')"
  if [ -z "$orphans" ]; then
    echo "    Сирот на VPS нет (исключённые пути не в счёт)."
    return 0
  fi
  in_backends="$(printf '%s\n' "$orphans" | grep '^backends/' || true)"
  outside="$(printf '%s\n' "$orphans" | grep -v '^backends/' || true)"
  if [ -n "$in_backends" ]; then
    if [ "$APPLY" = "1" ]; then
      echo "    Сироты в backends/ — удаляются сейчас (rsync --delete по backends/: иначе попадут в образ):"
    else
      echo "    Сироты в backends/ — удалятся при APPLY=1 (rsync --delete по backends/: иначе попадут в образ):"
    fi
    printf '%s\n' "$in_backends" | sed 's/^/      /'
  fi
  if [ -n "$outside" ]; then
    echo "    Сироты вне backends/ — deploy их НЕ удаляет (корень без --delete: прод-.env и бэкапы), удалить вручную на VPS при необходимости:"
    printf '%s\n' "$outside" | sed 's/^/      /'
  fi
}

# rsync льёт РАБОЧЕЕ дерево, а не git: незакоммиченное уедет на VPS, а с --delete по backends/
# рабочее дерево становится эталоном — удалённое локально удалится и на VPS.
warn_dirty_backends() {
  local dirty
  dirty="$(git -C "$ROOT_DIR" status --porcelain -- backends/ 2>/dev/null || true)"
  [ -n "$dirty" ] || return 0
  echo "⚠️  backends/ отличается от git — уедет на VPS как есть (а под --delete станет эталоном):"
  printf '%s\n' "$dirty" | sed 's/^/      /'
}

step_sync() {
  echo "—— sync: сироты на VPS (rsync -n --delete по всему дереву) ——"
  warn_dirty_backends
  local preview
  preview="$(rsync_preview)"
  report_orphans "$preview"
  echo "—— sync: rsync рабочего дерева → VPS (корень БЕЗ --delete) ——"
  rsync -az -e "$RSYNC_SSH" "${RSYNC_EXCLUDES[@]}" "$ROOT_DIR/" "${TARGET}:${VPS_PATH}"
  echo "—— sync: rsync --delete по backends/ ——"
  # backends/ — контекст сборки образа (Dockerfile: COPY . ./): сирота кода попала бы в образ.
  # Исключённое (node_modules, .env.*, logs…) без --delete-excluded не трогается. Корень —
  # без --delete: там прод-.env и бэкапы оператора. Печатаем только удаления: остальное уже
  # залил rsync выше.
  rsync -az --delete --itemize-changes -e "$RSYNC_SSH" "${RSYNC_EXCLUDES[@]}" \
    "$ROOT_DIR/backends/" "${TARGET}:${VPS_PATH%/}/backends/" | sed -n 's|^\*deleting  *|      удалено: backends/|p'
}

step_build() {
  echo "—— build: compose build api-node (прод пока на прежнем образе) ——"
  remote "${REMOTE_COMPOSE} build api-node"
}

step_migrate() {
  echo "—— migrate: миграции до старта нового кода (one-off compose run --rm) ——"
  # БД не запущена — поднять и дождаться healthy. Запущена — не трогать: `up` с изменённым
  # описанием сервиса пересоздал бы postgres (грабли M20).
  remote "${REMOTE_COMPOSE} ps --status running --services | grep -qx database-postgres || ${REMOTE_COMPOSE} up -d --wait database-postgres"
  # One-off на НОВОМ образе: api не трогается, порты не публикуются. Логи миграции — в этом
  # выводе и (M30) в journald с тегом maxtob24-api; в docker logs api их нет (контейнер удаляется).
  remote "${REMOTE_COMPOSE} run --rm --no-deps -T api-node node src/shared/db/runMigrations.js"
}

step_up() {
  echo "—— up: пересоздаю api на новом образе ——"
  # После Ctrl+C или обрыва SSH на этом шаге `compose up` прошлого запуска на VPS живёт дальше:
  # ssh без pty не шлёт ему SIGHUP, а его вывод принимает `tee -p` (ниже). Второй `up` поверх
  # него гонялся бы с ним: оба создают временный контейнер <id старого>_api, удаляют старый и
  # переименовывают. Поэтому сначала ждём его выхода. Процесс ищем по имени плагина
  # (docker-compose) — шелл этой команды и tee под шаблон не попадают.
  # shellcheck disable=SC2016
  local wait_prev='n=0
    while pgrep -a -x docker-compose | grep -F docker-compose.server.yml | grep -q " up "; do
      if [ "$n" -ge "$tries" ]; then
        echo "❌ прежний compose up на VPS не завершился за $((tries * delay)) с"; exit 96
      fi
      [ "$n" -gt 0 ] || echo "    на VPS ещё работает прежний compose up (старый api дренирует) — жду его выхода"
      n=$((n + 1)); sleep "$delay"
    done'
  remote "tries=${PREV_UP_TRIES} delay=${PREV_UP_DELAY}; ${wait_prev}"
  # M29: по SIGTERM старый процесс дренирует очередь исходящих с открытым портом (передача файла
  # доходит до конца), и `up -d` ждёт его выхода — до stop_grace_period 180 с. SSH такую паузу
  # переживает (ServerAlive, 5 мин тишины).
  echo "    up -d ждёт дренажа очереди старого процесса (до 3 мин); вывод на VPS — ${UP_LOG}"
  # --no-deps: postgres не трогаем — изменения его сервиса применяет `make prod-up-db` на VPS
  # (грабли M20: `up api-node` пересоздавал и postgres). --no-build: образ собран шагом build.
  # M30: `tee -p` с файлом. Во время дренажа compose молчит, но потом пишет «Recreated / Starting»
  # — после обрыва SSH это запись в закрытый канал sshd: EPIPE, compose выходит между созданием
  # нового контейнера и его стартом, и api остаётся в Created (воспроизведено через ssh с убитым
  # клиентом). tee держит канал compose открытым, потерю stdout не считает фатальной (-p) и
  # дописывает вывод в файл; без файла он вышел бы вместе со stdout. pipefail — код возврата
  # compose, а не tee (шелл пользователя деплоя — bash; в dash `set -o pipefail` упал бы громко, код 2).
  remote "set -o pipefail; mv -f ${UP_LOG} ${UP_LOG}.prev 2>/dev/null; ${REMOTE_COMPOSE} up -d --no-deps --no-build api-node 2>&1 | tee -p ${UP_LOG}"
}

step_health() {
  echo "—— health: http://${REMOTE_HEALTH_URL} на VPS (до ${HEALTH_TRIES} попыток через ${HEALTH_DELAY} с, попытка ≤ ${HEALTH_TIMEOUT} с) ——"
  # Loopback-порт живёт на хосте VPS, поэтому curl — через SSH. Цикл целиком исполняется
  # на VPS: тело в одинарных кавычках раскрывается там, параметры подставляются отдельно.
  # shellcheck disable=SC2016
  local loop='b=""
    for i in $(seq 1 "$tries"); do
      if b=$(curl -fsS --connect-timeout 3 --max-time "$max_time" "$url" 2>&1) && printf "%s" "$b" | grep -q "\"healthy\""; then
        echo "✅ health: healthy (попытка $i)"; exit 0
      fi
      sleep "$delay"
    done
    echo "❌ health: нет \"healthy\" за $tries попыток. Последний ответ: $b"; exit 1'
  remote "tries=${HEALTH_TRIES} delay=${HEALTH_DELAY} max_time=${HEALTH_TIMEOUT} url='http://${REMOTE_HEALTH_URL}'; ${loop}"
}

# Шаги от FROM включительно; неизвестный FROM — exit 2 со списком.
select_steps() {
  local step started=0
  RUN_STEPS=()
  for step in "${STEPS[@]}"; do
    if [ "$step" = "$FROM" ]; then started=1; fi
    if [ "$started" = 1 ]; then RUN_STEPS+=("$step"); fi
  done
  if [ "${#RUN_STEPS[@]}" -eq 0 ]; then
    echo "❌ Неизвестный шаг FROM=${FROM}. Шаги по порядку: ${STEPS[*]}"
    echo "   Пример догона: make deploy APPLY=1 FROM=migrate"
    exit 2
  fi
}

print_steps() {
  local step
  for step in "${RUN_STEPS[@]}"; do
    printf '      %-8s %s\n' "$step" "$(step_desc "$step")"
  done
}

run_steps() {
  local step
  for step in "${RUN_STEPS[@]}"; do
    CURRENT_STEP="$step"
    "step_${step}"
  done
  CURRENT_STEP=''
}

# --- Подкоманда: деплой ------------------------------------------------------
do_deploy() {
  select_steps
  echo "ℹ️  Деплой MAX↔Б24 на VPS"
  echo "    Хост:    ${TARGET}"
  echo "    Путь:    ${VPS_PATH}"
  echo "    Режим:   $([ "$APPLY" = "1" ] && echo 'APPLY (боевой)' || echo 'DRY-RUN (без записи на VPS)')"
  echo "    Шаги:    ${RUN_STEPS[*]}$([ "$FROM" = sync ] || echo " (FROM=${FROM}: предыдущие пропущены)")"
  echo "    rsync:   корень БЕЗ --delete, backends/ — с --delete; исключаем .env .env.* scripts/deploy.env backup_*.sql node_modules .pnpm-store .git logs .output .nuxt .ai-factory .ai-factory.json .claude .cursor .mcp.json docker-compose.override.yml"
  echo "    NB:      боевой .env на VPS НЕ трогаем (там собственный конфиг с секретами)."

  if [ "$APPLY" != "1" ]; then
    echo "—— DRY-RUN: на VPS ничего не пишем ——"
    if [ "${RUN_STEPS[0]}" = sync ]; then
      warn_dirty_backends
      # NB: -n всё равно подключается к VPS по SSH, чтобы вычислить дифф файлов.
      local preview plan
      preview="$(rsync_preview)"
      plan="$(printf '%s\n' "$preview" | grep -v -e '^\*deleting' -e '^$' || true)"
      echo "    План rsync (--itemize-changes; колонка слева — что и как изменится):"
      echo "${plan:-      (изменений нет)}"
      report_orphans "$preview"
    fi
    echo "    При APPLY=1 будут шаги:"
    print_steps
    echo "ℹ️  Для боевого запуска: make deploy APPLY=1$([ "$FROM" = sync ] || echo " FROM=${FROM}")"
    return 0
  fi

  run_steps
  echo "✅ Деплой завершён."
}

# --- Подкоманда: затянуть боевой .env с VPS (с бэкапом локального) ------------
do_pull_env() {
  echo "ℹ️  Затягиваю боевой .env с VPS → локальный .env.prod (содержимое НЕ печатаем)"
  echo "    Хост:      ${TARGET}"
  echo "    Источник:  ${VPS_PATH}.env"
  echo "    Назначение: ${ENV_PROD}"

  if [ -f "$ENV_PROD" ]; then
    local ts bak
    ts="$(date +%Y%m%d_%H%M%S)"
    bak="${ENV_PROD}.bak.${ts}"
    cp "$ENV_PROD" "$bak"
    echo "—— Бэкап старого .env.prod → ${bak} ——"
  else
    echo "—— Локального .env.prod ещё нет — бэкап не требуется ——"
  fi

  echo "—— scp ${TARGET}:${VPS_PATH}.env → ${ENV_PROD} ——"
  scp "${SSH_OPTS[@]}" "${TARGET}:${VPS_PATH}.env" "$ENV_PROD"
  echo "✅ Затянуто. Значения НЕ печатаем — проверь наличие ключей отдельно."
}

# --- Диспетчер подкоманд -----------------------------------------------------
CMD="${1:-deploy}"
case "$CMD" in
  deploy)   do_deploy ;;
  pull-env) do_pull_env ;;
  *)
    echo "Использование: [APPLY=1] [FROM=<шаг>] $0 [deploy|pull-env]"
    echo "  deploy    Деплой на VPS (DRY-RUN; APPLY=1 — боевой: ${STEPS[*]})"
    echo "            FROM=<шаг> — начать с шага (догон после сбоя)"
    echo "  pull-env  Забэкапить и затянуть боевой .env с VPS в локальный .env.prod"
    exit 2
    ;;
esac
