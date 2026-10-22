[← Outbound Queue](../backend/outbound-queue.md) · [Назад к README](../../README.md)

# Deploy runbook — боевой VPS (single-tenant prod)

Перенос двустороннего моста **MAX ↔ Open Lines** на боевой VPS под доменом
`__PROD_DOMAIN__` с валидным Let's Encrypt-TLS.

> Стек на dev описан в [../backend/architecture.md](../backend/architecture.md),
> переменные — в [../backend/env.md](../backend/env.md). Здесь — только prod-деплой.

---

## 1. Целевая схема (API-only)

```
Internet :443
  → caddy (ОБЩИЙ reverse-proxy хоста, network_mode: host, auto-TLS Let's Encrypt)
     → site-блок __PROD_DOMAIN__ (handle по путям):
         /webhook/*  → 127.0.0.1:5182  (api-node)
         /api/*      → 127.0.0.1:5182  (api-node)
         /b24/*      → 127.0.0.1:5182  (api-node)
         /health     → 127.0.0.1:5182  (api-node)
         /           → 127.0.0.1:5182  (api-node — API-only заглушка; установка headless через /api/install, см. §7)
```

Наш стек в `/home/__VPS_USER__/projects/maxtob24/` — 2 контейнера:
`api-node` (порт хоста `127.0.0.1:5182`),
`database-postgres` (только внутри docker-сети, наружу НЕ публикуется).
`restart: unless-stopped` на обоих.

Образ `api-node` — прод-стадия `backends/node/api/Dockerfile`: `node:24-alpine`, только
runtime-зависимости, `USER node`, `CMD ["node", "server.js"]`. PID 1 — сам node (SIGTERM от
`docker stop` получает `server.js`), pnpm и corepack в рантайме не участвуют: до M26
`pnpm run start` под `USER node` скачивал pnpm из registry.npmjs.org на каждом старте контейнера.
Проверка: `docker exec api node -v` → `v24.x`; `docker exec api cat /proc/1/cmdline | tr '\0' ' '` →
`node server.js`; в `docker logs api` нет строки `Corepack is about to download`.
По `SIGTERM` `server.js` не закрывает порт сразу, а дренирует очередь исходящих OL → MAX (M29):
передача файла доходит до конца, новые события обслуживаются. Docker ждёт этого до
`stop_grace_period: 180s` (§5, §10; runbook — [Outbound Queue](../backend/outbound-queue.md)).
Разовые `make register-*`/`probe-*`/`audit-bindings` тоже зовут node напрямую
(`docker compose exec api-node node scripts/<скрипт>.js`). Через `pnpm run` под `USER node`
corepack скачивал бы pnpm из registry (кэша у `node` нет — pnpm сборки лежит под root), а в
интерактивном `exec` с TTY ещё и спрашивал бы `Do you want to continue? [Y/n]`.

> **Только API.** Frontend-а нет: catch-all `/` в Caddy ведёт на api-node (`:5182`), который
> отдаёт JSON-заглушку. Установка приложения идёт **headless** через бэкенд-роут
> `/api/install` (Caddy `/api/*` → api-node).

**Критично:** path-routing на backend делает **Caddy** через `handle`-блоки. Все пути уходят на единственный api-node (`:5182`).

### ⚠️ Не трогать соседей

Если на VPS работают другие стеки, их не правим и не перезапускаем:
- `caddy` (общий Caddy, `/home/__VPS_USER__/projects/caddy/`) — правим ТОЛЬКО добавлением
  своего site-блока (§6);
- остальные проекты за тем же Caddy — каждый на своём localhost-порту; только чтение, их порты
  не трогать.

Наш порт — `127.0.0.1:5182`. Новый localhost-порт брать вне занятых (`ss -ltn` на VPS).

---

## 2. Доступ к VPS

- Хост — VPS в РФ (ниже — почему); как переезжать на другой хост — §12.
- SSH — по алиасу из `~/.ssh/config` машины деплоя: `ssh <алиас>`, у каждой машины свой ключ.
  Тот же алиас — `VPS_HOST` в `scripts/deploy.env` (§4). Пользователь `__VPS_USER__`, sudo без пароля.
- Проверено на Ubuntu 26.04 LTS. Мосту хватает малого VPS: в покое `api` занимает ~90 МиБ RSS,
  файлы идут потоком через диск (память не растёт с размером файла).
- **Compose:** Docker 29 и только плагин `docker compose` (v5; legacy `docker-compose` v1 нет).
  Makefile параметризован: `DOCKER_COMPOSE ?= docker compose`.
- В Ubuntu 26.04 coreutils — uutils (Rust), `sudo` — sudo-rs. Что на них держится, проверено:
  `tee -p` при закрытом stdout дописывает файл до конца и не падает (шаг `up`, §4),
  `sudo journalctl` работает (`make prod-journal`, §5).
- DNS: `A __PROD_DOMAIN__ → <IP VPS>`.

**Хост — в РФ.** С зарубежного хоста (замер — Амстердам) портал Б24 отвечает через раз: имя
портала резолвится во множество IP, и к части из них TLS-рукопожатие виснет (фильтрация на
российской стороне, не MTU); до 10–25 % запросов к Б24 кончались таймаутом. Мост ходит в портал на
каждом входящем (`imconnector.send.messages`) и за токеном, поэтому с хоста в РФ — без сбоев.

---

## 3. Prod-окружение (`.env`)

Шаблон — `.env.prod.example` (в репо, без секретов). Боевой `.env` с реальными
секретами живёт **только на VPS** (`<VPS_PATH>/.env`, под `.gitignore`). Резервную
копию на локаль (`.env.prod`) тянет `make pull-prod-env` (см. §4а); деплой кода
(`make deploy`) этот файл на VPS **не заливает** (исключён из rsync).

Ключевые prod-значения (значения секретов — плейсхолдеры):

| Переменная | Значение | Назначение |
|---|---|---|
| `NODE_ENV` | `production` | |
| `BUILD_TARGET` | `production` | compose читает `target: ${BUILD_TARGET}` |
| `LOG_LEVEL` | `info` | правило проекта: info для prod |
| `MAX_PUBLIC_WEBHOOK_URL` | `https://__PROD_DOMAIN__/webhook/max` | подписка MAX |
| `MAX_API_BASE_URL` | `https://platform-api2.max.ru` | канонический хост MAX; корень Минцифры уже в образе (`NODE_EXTRA_CA_CERTS`, см. [env.md](../backend/env.md)). Запасной — `https://botapi.max.ru` |
| `TRUST_PROXY` | не задавать (дефолт `loopback, uniquelocal`) | реальный IP за Caddy → docker-proxy: шлюз docker-сети в `172.16/12`. Если сеть проекта вне этой подсети — указать её явно |
| `B24_EVENT_HANDLER_URL` | `https://__PROD_DOMAIN__/webhook/b24` | `event.bind` |
| `B24_PLACEMENT_HANDLER_URL` | `https://__PROD_DOMAIN__/b24/connector-settings` | заглушка коннектора |
| `B24_PORTAL` | `example.bitrix24.ru` | |
| `B24_CLIENT_ID` / `B24_CLIENT_SECRET` | **обязательны** | проверка install-callback'а (без них `/api/install` → 503) и auto-refresh access_token (без них inbound «замолкает» через ~1 ч) |
| `MAX_BOT_TOKEN`, `MAX_WEBHOOK_SECRET`, `DB_*`/`DATABASE_URL` | секреты | |

Смена `MAX_API_BASE_URL` (и любой переменной `.env`) вступает в силу только после
`up -d --force-recreate api-node`: `restart` env не перечитывает.

`B24_APPLICATION_TOKEN` — **опционален** (см. §7): основной путь — `application_token`
персистится в БД из `ONAPPINSTALL`-callback'а; env-значение нужно лишь как fallback для
верификации `/webhook/b24`, пока callback задержался (приоритет: токен из БД > env). После
удаления приложения (`installations.uninstalled_at`, M26) fallback не действует: вебхук
открывает только переустановка.

---

## 4. Деплой кода — `make deploy` (M12.8, шаги — M26)

Деплой с локали — одной идемпотентной командой. Координаты VPS берутся из
`scripts/deploy.env` (gitignored; шаблон — `scripts/deploy.env.example`). Боевой `.env`
на VPS **не трогается** (там собственный конфиг с секретами, см. §3).

Деплоить можно с любой машины, у которой есть SSH-доступ к VPS (локаль, dev-сервер).
`VPS_HOST` может быть алиасом из `~/.ssh/config`: `TARGET` = `VPS_USER@VPS_HOST`, и SSH
подхватит блок `Host <алиас>` (HostName, IdentityFile) — так у каждой машины свой ключ.

```bash
make deploy                    # DRY-RUN: план rsync, отчёт о сиротах, список шагов; на VPS ничего не пишет
make deploy APPLY=1            # боевой: sync → build → migrate → up → health
make deploy APPLY=1 FROM=migrate   # догон после сбоя: с шага migrate и дальше
```

`make deploy` делегирует в `scripts/deploy.sh`. Шаги идут по порядку, каждый идемпотентен:

| Шаг | Что делает | Прод во время шага |
|---|---|---|
| `sync` | отчёт о сиротах; `rsync -az` дерева (корень **без `--delete`**), затем `rsync --delete` только по `backends/` | прежний код |
| `build` | `compose build api-node` | прежний код |
| `migrate` | postgres не запущен — `up -d --wait database-postgres`, иначе не трогаем; миграции в one-off `compose run --rm --no-deps -T api-node node src/shared/db/runMigrations.js` на **новом** образе | прежний код на новой схеме |
| `up` | ждёт прежний `compose up`, если он ещё идёт на VPS (после Ctrl+C или обрыва SSH, ниже); `compose up -d --no-deps --no-build api-node` — пересоздание `api` на новом образе; старый процесс сперва дренирует очередь исходящих (до 3 мин) | прежний код дренирует с открытым портом, разрыв ~1 с, новый код |
| `health` | на VPS до 20 попыток через 3 с `curl -fsS --connect-timeout 3 --max-time 5 http://127.0.0.1:5182/health` → `"healthy"`; попытка не дольше 5 с, весь шаг — не дольше 20 × (5 + 3) с ≈ 2,7 мин | новый код |

Команды compose идут на VPS по SSH с профилями `node,db-postgres`, `BUILD_TARGET=production`
и обоими файлами (`-f docker-compose.yml -f docker-compose.server.yml`). Health-check
исполняется на хосте VPS: loopback-порт живёт там, локальный curl до него не достанет. Предел
попытки нужен на случай, когда `api` принял соединение, но не отвечает: без него curl ждал бы
бесконечно, SSH жив (ServerAlive), и деплой висел бы без подсказки догона.

**Миграция до старта нового кода.** До M26 деплой делал `up -d --build`, и новый код стартовал
раньше миграции. Теперь миграция идёт отдельным one-off контейнером до пересоздания `api`:
- упавший `migrate` оставляет прод на прежнем коде;
- между `migrate` и `up` прежний код работает на новой схеме, поэтому миграции — только
  расширяющие (деструктивные — в два выката, см. [migrations.md](../backend/migrations.md));
- one-off не конфликтует с `container_name: api`, порты не публикует, после себя удаляется.
  Его логи (`migration applied …` / `no migrations to apply`) — в выводе деплоя и в journald
  (`make prod-journal`, M30, §5), в `docker logs api` их нет. Порядок проверяется по `schema_migrations.applied_at` и
  `docker inspect api --format '{{.State.StartedAt}}'`.

**`up` ждёт дренажа (M29).** Старый `api` по `SIGTERM` держит порт открытым, пока не закончатся
исходящие в работе (до `SHUTDOWN_DRAIN_TIMEOUT_MS`, 170 с), и `up -d` ждёт его выхода до
`stop_grace_period: 180s`. Шаг печатает `up -d ждёт дренажа очереди старого процесса (до 3 мин)`;
SSH такую паузу переживает. Новый контейнер стартует после выхода старого: разрыв ~0,6–1,2 с,
событие Б24 в это окно получит 502 от Caddy, и Б24 его не повторит — риск принят (§6,
«Ретраев апстрима нет»). Перед выкатом можно проверить на VPS, что передач в работе нет
(read-only), — ожидаем `0`:

```bash
docker compose exec -T database-postgres psql -U appuser -d appdb -tAc \
  "SELECT count(*) FROM message_log WHERE status = 'in_progress'"
```

**Первый выкат с `stop_grace_period`** идёт по старым правилам: grace пишется в контейнер при
создании, и старый `api` останавливается по своим прежним 10 с, а старый код порт сразу
закрывает и строк заданий не пишет. Передача, идущая в этот момент, теряется без оповещения —
выкатывать, когда операторы не шлют файлы (в `docker logs --since 5m api` нет свежих
`routeOutboundFile`). После выката: `docker inspect api --format '{{.Config.StopTimeout}}'` → `180`.

**`--no-deps` на `up`.** Деплой не применяет изменения сервиса `database-postgres` из compose: `up`
с изменённым описанием пересоздал бы postgres (грабли M20). Такие изменения — `make prod-up-db` на
VPS вручную (§5): он сперва останавливает `api` с дренажом и только потом пересоздаёт БД.

**Сбой, Ctrl+C, обрыв SSH.** При сбое, Ctrl+C или `SIGTERM` (таймаут или kill запустившего
инструмента — агента, CI; выход 143) скрипт печатает шаг, состояние прода и команду догона
`make deploy APPLY=1 FROM=<шаг>`. `SIGTERM` всей группе процессов (`timeout`, агент) обрывает и
`ssh` — подсказка сразу; `SIGTERM` одному процессу скрипта bash обработает только после конца
текущей удалённой команды. Неизвестный `FROM` — exit 2 со списком шагов.
- SSH, rsync и scp идут с `-o ServerAliveInterval=15 -o ServerAliveCountMax=20 -o ConnectTimeout=20`:
  обрыв только после 5 мин тишины. Опции командной строки сильнее `~/.ssh/config`.
- Обрыв на `migrate`: CLI `compose run` умирает, а one-off контейнер дорабатывает миграцию сам.
  Повторный `FROM=migrate` ждёт его на advisory lock (`runMigrations`) и не применяет миграцию
  дважды; ожидание видно в выводе — `migrations lock busy`.
- Ctrl+C или обрыв SSH на `up` не останавливают `compose up` на VPS: `ssh` без pty не шлёт ему
  `SIGHUP`. Compose к этому моменту уже создал замену под временным именем `<id>_api`; после
  выхода старого он удаляет его, переименовывает замену в `api` и стартует её. Вывод compose
  идёт через `tee -p` в `~/maxtob24-deploy-up.log` пользователя деплоя на VPS (M30; прежний
  запуск — в `.prev`, догон его не затирает). До этого compose, промолчав весь дренаж, падал на
  первой же записи `Recreated` в закрытый канал sshd (EPIPE) и оставлял `api` в `Created` — прод
  лежал до ручного `FROM=up` (воспроизведено 2026-10-09 через ssh с убитым клиентом). Теперь
  `tee` держит канал compose открытым, потерю своего stdout не считает фатальной, и compose
  доводит пересоздание до конца; итог — в этом файле. Лог — не в `/tmp`: чужой файл с тем же
  именем tee там не откроет (`fs.protected_regular`), и защита не сработала бы. `setsid`/`flock`
  не нужны: `SIGHUP` не приходит, а параллельный `up` сериализован (ниже). Не спасает только
  жёсткое убийство compose на VPS — поэтому:
  - `FROM=up` сначала ждёт, пока на VPS работает прежний `compose up` (процесс `docker-compose`
    с `up` в аргументах; до 200 с, не дождался — код 96), и только потом запускает свой: два
    `up` гонялись бы за `<id>_api` и переименование;
  - руками на VPS — только после выхода прежнего compose (`pgrep -a -x docker-compose` — нет
    строки с `up`). Затем `docker ps -a --filter name=api`: `api` `Up` на новом образе —
    `FROM=health`; `api` `Created`/`Exited` или его нет — `FROM=up`; остался дубль `<id>_api` —
    `docker rm` его, затем `FROM=up`. Удалить дубль при живом compose — оставить прод без `api`:
    compose удалит старый контейнер и упадёт на переименовании.

**Сироты** — файлы на VPS, которых нет в рабочем дереве (удалены из репо). DRY-RUN и `sync`
печатают их по `rsync -n --delete` всего дерева двумя группами:
- **под `backends/`** — удаляются при `APPLY=1` (`rsync --delete` только по `backends/`): это
  контекст сборки образа (`Dockerfile`: `COPY . ./`), сирота кода попала бы в образ;
- **вне `backends/`** — деплой их **не удаляет**: корень льётся без `--delete`, чтобы не задеть
  прод-`.env` и бэкапы. Это старые `docs/`, `scripts/`, корневые файлы — удалить вручную на VPS
  по отчёту, когда нужно.

Исключённые пути (`.env`, `.env.*`, `backup_*.sql`, `node_modules`, `.git`, `logs`, `.claude`…)
в отчёт не попадают и под `--delete` не удаляются: без `--delete-excluded` rsync их не трогает.

> ⚠️ `rsync` льёт **рабочее дерево**, а не git. Незакоммиченное уедет на VPS, а с `--delete`
> по `backends/` рабочее дерево становится эталоном: удалённое локально удалится и на VPS.
> DRY-RUN и шаг `sync` предупреждают списком, если `git status` по `backends/` непустой. Деплоить
> из чистого дерева (для конкретного коммита — `git switch --detach <коммит>`).

DRY-RUN с `FROM`, отличным от `sync` (например, `make deploy FROM=health`), к VPS не
подключается и печатает только список шагов: план rsync и отчёт о сиротах относятся к шагу `sync`.

Исключения rsync: `.env`, `.env.*`, `backup_*.sql`, `scripts/deploy.env`, `node_modules`,
`.pnpm-store`, `.git`, `logs`, `.output`, `.nuxt`, локальная dev-кухня (`.ai-factory*`,
`.claude`, `.cursor`, `.mcp.json`) и `docker-compose.override.yml` dev-машины.

**Место на диске.** Перед деплоем, особенно со сменой базового образа: `df -h /` и
`docker system df` на VPS. Build cache растёт с каждой сборкой; `docker builder prune` —
только с согласия владельца прода, не автоматом и не из `deploy.sh`.

**Откат.** Перед рискованным выкатом на VPS: `docker tag maxtob24-api-node:latest
maxtob24-api-node:pre-<веха>`. Откат образа — `docker tag maxtob24-api-node:pre-<веха>
maxtob24-api-node:latest`, затем `make deploy APPLY=1 FROM=up`. Код откатывать `git revert` и
деплоить текущим `deploy.sh`: checkout старого коммита вернул бы и старый `deploy.sh`.

> ⚠️ **Упразднено (M12.8):** прежний ручной `rsync --delete` по всему дереву + `scp ./.env.prod → :.env`.
> `--delete` сносил прод-`.env` и операторские бэкапы на VPS, а `scp` затирал боевой конфиг.
> С M26 `--delete` действует только внутри `backends/`, корень и `.env` не трогаются.

VPS доступ к GitHub НЕ нужен.

### 4а. Бэкап прод-`.env` на локаль — `make pull-prod-env`

Единственная боевая копия `.env` живёт на VPS. Чтобы снять резервную копию на локаль:

```bash
make pull-prod-env     # бэкап старого ./.env.prod → ./.env.prod.bak.<ts>, затем scp VPS:.env → ./.env.prod
```

Файлы `./.env.prod` и `./.env.prod.bak.*` — под `.gitignore` (паттерн `.env.*`); содержимое
и значения секретов **не печатаются** в логах команды.

---

## 5. Поднять стек + миграции (примитивы на VPS)

> `make prod-up`/`make prod-migrate` — **ручные примитивы, запускаются НА VPS**. При боевом
> `make deploy APPLY=1` (§4) эти шаги выполняются автоматически по SSH с локали. Команды ниже
> нужны для ручного управления стеком прямо на сервере.

```bash
cd /home/__VPS_USER__/projects/maxtob24

make prod-up        # build api-node → up -d --wait database-postgres → миграции → up -d (ждёт дренажа старого api)
make prod-up-db     # изменения сервиса БД: build api-node → stop api-node (ждёт дренажа) → up -d --wait database-postgres → миграции → up -d
make prod-migrate   # только миграции: run --rm --no-deps -T api-node node src/shared/db/runMigrations.js
```

Все цели — с `COMPOSE_PROFILES=node,db-postgres BUILD_TARGET=production` и обоими compose-файлами.
`prod-up` идёт в том же порядке, что `make deploy` (миграции на новом образе до пересоздания `api`),
но без `--no-deps`. Миграции — в one-off контейнере (`run --rm`), а не `exec` в работающем `api`:
тот ещё на старом образе. Параллельный прогон (например, с недоработавшим one-off после обрыва
деплоя) ждёт advisory lock.

**Изменения сервиса `database-postgres`** (образ, healthcheck, тома) — только `make prod-up-db`.
`prod-up` пересоздал бы postgres шагом `up -d --wait database-postgres` под работающим старым
`api`, ещё до его дренажа: задания в работе (передача файла, запись результата, снятие строки
задания) упали бы на БД, а событие Б24 в это окно получило бы 500 — Б24 его не повторит. Это
тот же порядок, что при перезапуске БД (§10): сначала `stop api-node` с дренажом, затем БД.
`prod-up-db` собирает образ, пока `api` работает, затем останавливает его (дренаж до 3 мин, порт
открыт). Простой — от выхода старого `api` до старта нового: пересоздание БД и миграции. Упала
БД или миграция — `api` остаётся остановленным, цель печатает подсказку: исправить и повторить
`make prod-up-db` (идемпотентна) либо вернуть прежний `api` — `docker start api`.

Проверка:
```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml ps   # 2× Up, postgres healthy
curl -s 127.0.0.1:5182/health   # {"status":"healthy",...}
curl -s 127.0.0.1:5182/         # JSON-заглушка api-node: ["max-b24-connector","mode: api-only",...]
docker compose exec -T database-postgres psql -U appuser -d appdb -c '\dt'  # installations, chat_bindings, participant_map, message_log
```

При нехватке места под build: `docker builder prune` — с согласия владельца прода (§4, «Место на
диске»).

### Про `docker-compose.server.yml` (prod-override)

Применяется поверх базового: `-f docker-compose.yml -f docker-compose.server.yml`.
Семантика тегов Compose (проверена live, НЕ перепутать):
- **`!override <список>`** — ЗАМЕНЯет список (оставляет только новое значение).
  Используется у api-node для `ports: ["127.0.0.1:5182:8000"]`.
- **`!reset []`** — УДАЛЯет ключ целиком. Используется для `ports: !reset []` у postgres
  (не публиковать 5432 наружу) и `volumes: !reset []` у api-node (снять dev bind-mount
  `./backends/node/api:/app`, иначе он затрёт собранный образ).
- ⚠️ `!reset <непустой список>` тоже ДРОПНЕТ ключ — значение потеряется. Для
  «заменить с сохранением» — ТОЛЬКО `!override`. Ошибочный `!reset` на `ports` api-node
  → api без публикации → Caddy `reverse_proxy 127.0.0.1:5182` отдаёт 502, мост умрёт.

У `api-node` в prod-override — **логи в journald** (M30): `logging: driver: journald`, тег
`maxtob24-api`. Лог `json-file` по умолчанию удаляется вместе с контейнером на каждом деплое, а
`message_log` пишет только успех — неудачи (недоставка, отказы MAX, прерванные передачи) были
видны лишь с последнего пересоздания. Журнал переживает пересоздание, туда же идут one-off
миграции. Чтение:
- `docker logs api` / `make prod-logs` — как раньше, только текущий контейнер;
- `make prod-journal` (на VPS) — история через пересоздания: `sudo journalctl -t maxtob24-api -o cat`
  (пользователь деплоя обычно не в группе `systemd-journal`; без sudo journalctl молча покажет пусто). По умолчанию —
  последние 500 строк, фильтры — через `ARGS`, напр. `make prod-journal ARGS="--since '2 hours ago'"`.
  Строки — JSON pino как есть; ошибки ищутся по `"level":50` (уровень pino в приоритет journald
  не переходит: весь stdout — `PRIORITY=6`). Строку длиннее 16 КиБ Docker пишет в журнал
  кусками — для `jq` такую строку брать из `docker logs`, он склеивает.
Хранение — системный journald (`/var/log/journal`, лимит по умолчанию — 10 % ФС, не больше 4 ГБ); наш поток
~170 строк/ч. Журнал общий для всего хоста. Смена драйвера действует с пересоздания `api`
(шаг `up`). Журнал живёт на хосте и при переезде не переносится: история — с первого запуска на
новом хосте (§12).

Ещё у `api-node` в prod-override — **`stop_grace_period: 180s`** (M29): сколько Docker ждёт выхода
процесса после `SIGTERM`, прежде чем добить `SIGKILL`. Держать больше
`SHUTDOWN_DRAIN_TIMEOUT_MS` (170 с) не меньше чем на 10 с: 5 с на закрытие порта и пула (жёсткий
таймер процесса — дедлайн + 5 с) и запас до `SIGKILL`. Значение пишется в контейнер
(`StopTimeout`) при создании и действует на `docker stop`/`restart`, `compose up` с пересозданием
и `down`. В базовом `docker-compose.yml` его нет: dev работает на nodemon, grace по умолчанию — 10 с.

---

## 6. Caddy site-блок + TLS

> Файл `/home/__VPS_USER__/projects/caddy/Caddyfile` живёт на VPS ВНЕ репо. Здесь — снимок блока.

Перед правкой — бэкап и валидация:
```bash
cp /home/__VPS_USER__/projects/caddy/Caddyfile /home/__VPS_USER__/projects/caddy/Caddyfile.bak.$(date +%s)
```

Блок (глобальный блок, bare-IP-блок и блоки соседей не трогать). Все пути уходят на api-node
(`:5182`):
```caddy
__PROD_DOMAIN__ {
    encode gzip
    handle /health    { reverse_proxy 127.0.0.1:5182 }
    handle /webhook/* { reverse_proxy 127.0.0.1:5182 }
    handle /api/*     { reverse_proxy 127.0.0.1:5182 }
    handle /b24/*     { reverse_proxy 127.0.0.1:5182 }
    handle            { reverse_proxy 127.0.0.1:5182 }
}
```
При переезде (§12), пока DNS расходится, прежний хост может пробрасывать 80/443 сюда (L4 с PROXY
protocol). Тогда в глобальном блоке нужен `proxy_protocol` с `allow` только адресов прежнего
хоста: так Caddy видит реальный IP клиента, от него зависят per-IP лимиты вебхуков
(`TRUST_PROXY`, §3). Когда прежний хост выключен — убрать.

**Ретраев апстрима нет — риск принят (M30).** На переключении контейнеров (деплой, рестарт)
есть окно ~1,15 с (замер на выкате: от удаления старого контейнера до готовности нового),
когда событие Б24 получает 502 и теряется: Б24 событий не повторяет. Из этого окна ~0,5 с
`docker-proxy` уже принимает соединение, а node ещё нет — для Caddy это не ошибка дозвона, и
одного `lb_try_duration` мало: нужны ещё `lb_retry_match { method POST }` и `request_buffers`
больше лимита тела express (исходник Caddy v2.11.2: POST после установленного соединения без
`lb_retry_match` не ретраится, тело переигрывается только целиком буферизованным). Ожидание
потерь ~0,1 события в год (за выкат в пиковый час — ≈0,06 %: ~1,9 события Б24 в час × окно).
Правка общего Caddyfile — только по согласованию с соседями.

Валидация + reload БЕЗ рестарта (соседи не перезапускаются):
```bash
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload   --config /etc/caddy/Caddyfile
```

LE-серт выписывается сам (DNS уже резолвится → ACME HTTP-01). Проверка с внешней машины:
```bash
curl -sI https://__PROD_DOMAIN__/health   # 200, валидная цепочка (не 410)
```
Откат: восстановить `Caddyfile.bak.<ts>` → `caddy reload`.

---

## 7. Установка приложения в режиме «Только API» (server-to-server install-callback)

> **M9 (2026-05-30):** приложение переведено в режим **«Только API»** — UI-мастера
> установки (`install.client.vue`) больше НЕТ. Приложение не имеет UI внутри Б24 и НЕ
> вызывает `BX24.installFinish()`. B24-токены (`access`/`refresh`/**`application_token`**)
> персистит сам Б24 — server-to-server POST'ом `ONAPPINSTALL`-payload'а на бэкенд-роут
> `/api/install` при сохранении формы. Прежний раздел про SPA `/install` и «страницу
> установки нельзя выключать» — УСТАРЕЛ.

Настройки **локального приложения** на портале `example.bitrix24.ru`:

| Поле | Значение |
|---|---|
| ☑ «Приложение **использует только API**» | **ВКЛЮЧЕНО** (поле «Путь обработчика» и пункт меню скрываются — UI в Б24 не нужен) |
| Путь для **первоначальной установки** (он же «Ссылка-callback для события установки») | `https://__PROD_DOMAIN__/api/install` (**БЭКЕНД-роут напрямую**, НЕ SPA `/install`) |

Порядок: выставить поля → **Сохранить**. При сохранении Б24:
1. **server-to-server POST'нет** `ONAPPINSTALL`-payload (`application/x-www-form-urlencoded`,
   event-style: `{event, data, auth:{access_token, refresh_token, application_token, member_id, ...}}`)
   на `/api/install`;
2. **покажет OAuth-ключи** `client_id` (C_REST_CLIENT_ID) / `client_secret`.

Бэкенд принимает токены, только доказав их подлинность: обменивает `refresh_token` из payload
на OAuth-сервере Б24 с `B24_CLIENT_ID`/`B24_CLIENT_SECRET` (обмен удаётся лишь для пары нашего
приложения) и сверяет портал. Контракт, коды ответов и негативные пробы —
[docs/backend/app-installation.md](../backend/app-installation.md).

### ⚠️ Client creds — до установки (КРИТИЧНО)

Без `B24_CLIENT_ID`/`B24_CLIENT_SECRET` install-callback отвечает **503**, а при неверных —
OAuth вернёт `invalid_client` (тоже 503, error-лог «check B24_CLIENT_ID / B24_CLIENT_SECRET»).
Б24 событие не повторяет. Поэтому:
- **первая установка:** сохранить форму → скопировать показанные `client_id`/`client_secret`
  в prod-`.env` → `up -d --force-recreate api-node` (`restart` env не перечитывает) →
  **пересохранить форму** (придёт новый `ONAPPINSTALL`);
- **переустановка/смена режима:** сравнить показанные ключи с prod-`.env`. Если Б24 их
  перевыпустил — обновить `.env`, пересоздать контейнер и пересохранить форму. Если совпали —
  `.env` не трогать. После настоящего **удаления** приложения (`ONAPPUNINSTALL`) локальное
  приложение создаётся заново с новыми ключами — порядок в
  [app-installation.md](../backend/app-installation.md#переустановка).

Без верных ключей не работает и auto-refresh: inbound «замолчит» через ~1 ч (см. §3).

### ⚠️ Задержка callback'а и env-fallback

Обработчики событий Б24 могут сработать **с задержкой** (офиц. доки). Если после сохранения
токены в БД ещё NULL — дать время и перепроверить БД. Страховка: верификация `/webhook/b24`
поддерживает env-fallback **`B24_APPLICATION_TOKEN`** (приоритет: токен из БД > env > none) —
можно временно проставить его в prod-`.env` для немедленного приёма событий. После удаления
приложения (M26) fallback не поможет: `/webhook/b24` отвечает `503 B24_APP_UNINSTALLED`, пока
не пройдёт переустановка.

Проверка успешной установки:
```bash
docker compose exec -T database-postgres psql -U appuser -d appdb \
  -c "select b24_application_token is not null as app_tok, \
             b24_access_token   is not null as access,  \
             b24_refresh_token  is not null as refresh, \
             b24_member_id      is not null as member from installations;"
# ожидаем: app_tok=t, access=t, refresh=t, member=t
```
В логах api-node при сохранении формы: `install request received`
(`hasRefresh:true, hasApplicationToken:true`) → `install verified: tokens saved` →
`POST /api/install → 200`. OAuth-рефреш строку `install request received` **не** пишет —
каждая такая строка в логах означает настоящий запрос на `/api/install`. Отказы — `install
rejected: …` (warn) с причиной. Секреты НЕ логируются. Negative-probe `/webhook/b24` с неверным
токеном → **401** `B24_AUTH_INVALID` (не 503) подтверждает, что токен в системе есть.

---

## 8. Перерегистрация MAX / B24 на боевой домен

Запускать на VPS (`cd /home/__VPS_USER__/projects/maxtob24`) после §6–7 (нужен живой TLS и
свежий `access_token` в БД).

**MAX webhook** (idempotent, не дублирует на тот же URL):
```bash
make register-webhook ARGS="--list"   # текущие подписки
make register-webhook                 # подписка на MAX_PUBLIC_WEBHOOK_URL
```
Новый тип события в дефолте (`chat_title_changed`, M24) в существующую подписку сам не
попадёт — `ARGS="--force"`, порядок проверки — [max-webhook-setup.md](../backend/max-webhook-setup.md#обновить-список-событий---force).

**B24 event-handler** — пять событий на `/webhook/b24`: `ONIMCONNECTORMESSAGEADD`/`…UPDATE`/`…DELETE`,
`ONIMCONNECTORDIALOGFINISH` (M25) и `ONAPPUNINSTALL` (удаление приложения, M26; на URL установки Б24
его сам не регистрирует — нужен `event.bind`, см. [app-installation.md](../backend/app-installation.md#удаление-и-переустановка-m26)):
```bash
make register-events ARGS="--list"     # увидеть старый bind (dev-туннель?)
make register-events                   # idempotent bind на боевой URL (доподпишет недостающие)
make register-events ARGS="--list"     # перепроверить: пять событий на /webhook/b24, среди них ONAPPUNINSTALL
```
Проверка `ONAPPUNINSTALL` на проде — только негативная (удалить боевое приложение нельзя):
поддельное событие → `401`, токены в `installations` прежние — проба в
[app-installation.md](../backend/app-installation.md#проверки-и-ручная-очистка).

Снять старый bind на dev-туннель (он остаётся — скрипт `--unregister` снимает ТЕКУЩИЙ
`B24_EVENT_HANDLER_URL`; чтобы убрать именно старый — переопределить URL только для команды):
```bash
docker compose exec -T \
  -e B24_EVENT_HANDLER_URL=https://<СТАРЫЙ-dev-хост>/webhook/b24 \
  api-node node scripts/register-events.js --unregister
```
> Зачем убирать: хосты туннелей переназначаются — B24 продолжит слать туда события
> Open Lines (с содержимым сообщений) → потенциальная утечка.

**Коннектор** (активация на линии `OL_LINE_ID`):
```bash
make register-connector
```
> NB: при уже зарегистрированном коннекторе `imconnector.register` **пропускается**
> (наша логика по `imconnector.list`), поэтому `placementHandlerUrl` коннектора со
> старого dev-хоста НЕ обновится автоматически. Это **заглушка** (`/b24/connector-settings`),
> данные через неё не ходят — риск косметический, обновление = post-MVP.

---

## 9. Бэкап / восстановление Postgres

```bash
make prod-db-backup    # → backup_<YYYYMMDD_HHMMSS>.sql (pg_dump)
# восстановление:
make db-restore file=backup_<...>.sql    # psql < dump (на остановленном трафике)
```
Cron-бэкап — опционально (post-MVP).

> Дампы `backup_*.sql` под `.gitignore` (M12.8). `make deploy` льёт корень **без
> `--delete`** (§4; `--delete` — только внутри `backends/`), а `backup_*.sql` и `.env.*`
> исключены из rsync, поэтому существующие на VPS дампы и операторские `.env.bak.*` при
> деплое сохраняются.

---

## 10. Выживание после рестарта / reboot

```bash
# ВАЖНО: COMPOSE_PROFILES обязателен, иначе restart — no-op (profiled-сервисы не выбраны)
COMPOSE_PROFILES=node,db-postgres \
  docker compose -f docker-compose.yml -f docker-compose.server.yml restart api-node
# restart возвращается, когда api уже перезапущен; старый процесс сперва дренирует очередь
# исходящих — до 3 мин. Дальше ждём готовности нового:
for i in $(seq 1 20); do
  curl -fsS --max-time 5 127.0.0.1:5182/health | grep -q '"healthy"' && echo healthy && break
  sleep 3
done
docker compose -f docker-compose.yml -f docker-compose.server.yml ps   # 2× Up
curl -sI https://__PROD_DOMAIN__/health                              # 200
```
`restart: unless-stopped` поднимает стек сам; том `postgres_data` сохраняет данные/токены.

**Остановка ждёт дренажа.** `docker stop`/`restart`, `compose up -d` (пересоздание api) и
`make prod-down` шлют api `SIGTERM` и ждут его выхода до `stop_grace_period: 180s`
(`docker-compose.server.yml`). Всё это время процесс держит порт открытым и обслуживает новые
события, пока очередь исходящих не опустеет и не ответят запросы в работе: передача файла
доходит до конца. В `docker logs api` — `shutdown requested: draining outbound queue (still listening)` →
`outbound queue drained` → `shutdown complete`. При пустой очереди остановка занимает меньше секунды.
Не уложился в дедлайн (170 с) — `drain timeout…`, выход 1, а новый процесс после
`server listening` оповестит оператора о прерванных передачах (`interrupted outbound jobs found`).
Подробности — [Outbound Queue](../backend/outbound-queue.md).

**Перезапускайте `api-node`, а не весь стек.** `restart` без имени сервиса перезапускает postgres
параллельно с api: БД уходит посреди дренажа, и задания, которым в это окно нужна БД, падают. Если
нужно перезапустить и БД — сначала `stop api-node` (ждёт дренажа), затем `restart
database-postgres`, затем `start api-node`; изменения сервиса БД — `make prod-up-db` (§5) в том же
порядке. `make prod-down` останавливает api раньше postgres.

**Reboot VPS обрезает дренаж до ~90 с.** systemd останавливает `docker.service` не дольше
`TimeoutStopUSec` (1 мин 30 с; `/etc/docker/daemon.json` нет), а daemon гасит контейнеры без
порядка compose: postgres может уйти раньше api. Передачи, не дошедшие к этому моменту,
оповестит оператора следующий старт моста (строки `job:` со `status='in_progress'` в
`message_log`).

**Полный `sudo reboot` VPS затронет соседей** (их сервисы тоже перезапустятся) —
согласовывать отдельно; для проверки нашего стека достаточно `compose restart api-node`.

---

## 11. Success signals (приёмка M8)

- `https://__PROD_DOMAIN__/health` → 200 с валидным TLS; `/` отдаёт JSON-заглушку api-node
  (`["max-b24-connector","mode: api-only",...]`), НЕ HTML.
- Приложение установлено: `app_tok=t, access=t, refresh=t` в `installations`.
- Двусторонний мост MAX⇄OL работает напрямую через домен, без dev-туннеля (inbound `delivered to Open Line`,
  outbound `delivered to MAX` + `sendDeliveryStatus: ok`), дубли не плодятся,
  авто-онбординг новой группы создаёт `binding`.
- `compose restart api-node` (с `COMPOSE_PROFILES` и обоими `-f`, §10) → api поднимается сам, мост
  жив. Весь стек не перезапускать: postgres ушёл бы посреди дренажа api (§10).
- Блоки соседей продолжают отвечать (regression-check).

---

## 12. Переезд на другой хост

Порядок проверен двумя переездами прода между хостами. IP в мосте нигде не зашит: подписка MAX, `event.bind`
Б24 и install-callback смотрят на домен. После смены `A`-записи перерегистрация не нужна.

**Два живых стека — нельзя.** Б24 выдаёт новый `refresh_token` на каждом рефреше, прежний сразу
недействителен. Второй стек с копией БД получит `invalid_grant`, и вернуть токен можно только
переустановкой приложения (§7). Кроме того, события, пришедшие на старый хост, запишутся в его
`message_log`, а на новый хост не попадут. Порядок:

1. Новый хост: Docker с плагином compose, `make`, `rsync`, `curl`; Caddy с site-блоком (§6). Для
   сборки образа с хоста нужны Docker Hub и registry.npmjs.org.
2. Старый хост: `stop api-node` (дренаж до 3 мин, §10), затем `stop database-postgres`.
3. Перенести каталог проекта вместе с боевым `.env` и том `maxtob24_postgres_data` в остановленном
   виде (или `make prod-db-backup` → `make db-restore`, §9). Образ пересобрать на новом хосте или
   перенести `docker save | docker load`. Первая сборка на новом хосте идёт без кэша: ~4 мин,
   из них `apk add openssl` с CDN Alpine — 2,4 мин. Дальше слой берётся из кэша.
4. Новый хост: `make prod-up` (§5), затем `curl 127.0.0.1:5182/health`.
5. `A __PROD_DOMAIN__ → <новый IP>`. Пока DNS расходится, старый хост может пробрасывать 80/443 на
   новый (L4 с PROXY protocol, §6); свой стек на нём остановлен.
6. Машина деплоя: алиас в `~/.ssh/config` и `VPS_HOST` в `scripts/deploy.env`. `make deploy`
   (DRY-RUN) покажет план rsync до нового хоста.

**Проверка после переезда** — только чтение:
- с внешней машины `curl -sI https://__PROD_DOMAIN__/health` → 200, цепочка Let's Encrypt, IP
  нового хоста; `POST /webhook/max` без секрета → 401;
- `make register-webhook ARGS="--list"` — MAX доступен из контейнера, подписка смотрит на домен;
- портал Б24 из контейнера отвечает без таймаута (404 на `/rest/` — норма):
  ```bash
  docker exec api node -e "fetch('https://'+process.env.B24_PORTAL+'/rest/').then(r=>console.log(r.status))"
  ```
- в `installations` токены не NULL (запрос — §7), в `message_log` строк со
  `status = 'in_progress'` — 0 (§4);
- `make prod-journal` показывает строки нового хоста.

`make register-events ARGS="--list"` по Б24 тоже только читает, но с истёкшим `access_token` мост
сделает рефреш. Запускать — когда старый стек точно остановлен.
