.PHONY: help dev-node deploy pull-prod-env prod-up prod-up-db prod-down prod-logs prod-journal prod-migrate prod-db-backup status ps down down-all logs clean register-connector register-webhook register-events audit-bindings probe-imconnector probe-max-send probe-max-upload security-scan security-tests db-backup db-restore

# Variables
# Compose-бинарь. На сервере (прод — Ubuntu 26.04, Compose v5) есть ТОЛЬКО плагин `docker compose`
# (legacy `docker-compose` v1 отсутствует и не парсит !override/!reset из
# docker-compose.server.yml). `?=` позволяет переопределить из env, не ломая dev.
DOCKER_COMPOSE ?= docker compose
# Prod: базовый compose + override-файл (применяются вместе, см. docker-compose.server.yml).
COMPOSE_FILES_PROD = -f docker-compose.yml -f docker-compose.server.yml
PROD_PROFILES = node,db-postgres
# Prod-compose целиком: профили + BUILD_TARGET + оба файла (как REMOTE_COMPOSE в scripts/deploy.sh).
PROD_COMPOSE = COMPOSE_PROFILES=$(PROD_PROFILES) BUILD_TARGET=production $(DOCKER_COMPOSE) $(COMPOSE_FILES_PROD)
# M26: миграции — в one-off контейнере на образе api-node ДО пересоздания api (не `exec` в старом).
PROD_MIGRATE = $(PROD_COMPOSE) run --rm --no-deps -T api-node node src/shared/db/runMigrations.js
# Деплой с локали (scripts/deploy.sh). DRY-RUN по умолчанию; APPLY=1 — боевой.
APPLY ?= 0
# Шаг, с которого начать (догон после сбоя): sync|build|migrate|up|health. Пусто — с sync.
FROM ?=

# Default target - show help
help: ## Show this help message
	@echo "MAX ↔ Bitrix24 Connector - Available Commands"
	@echo "============================================="
	@echo ""
	@echo "🛠  Development:"
	@echo "  dev-node          Start backend (Postgres + api-node)"
	@echo ""
	@echo "🚀 Production (оркестраторы с локали):"
	@echo "  deploy            Деплой на VPS (DRY-RUN; APPLY=1 — боевой: sync→build→migrate→up→health;"
	@echo "                    FROM=<шаг> — догон с шага после сбоя)"
	@echo "  pull-prod-env     Затянуть прод-.env с VPS в локальный .env.prod (с бэкапом)"
	@echo ""
	@echo "🚀 Production (примитивы, запускаются НА VPS):"
	@echo "  prod-up           Prod stack: build → postgres → migrations → up (node + db-postgres)"
	@echo "  prod-up-db        То же при изменениях сервиса postgres: build → stop api (дренаж) → postgres → migrations → up"
	@echo "  prod-down         Stop prod stack"
	@echo "  prod-logs         Follow prod stack logs"
	@echo "  prod-journal      История логов api из journald через пересоздания (по умолчанию -n 500; ARGS=\"--since '1 hour ago'\")"
	@echo "  prod-migrate      Run DB migrations (one-off run --rm on the api-node image)"
	@echo "  prod-db-backup    Backup prod Postgres"
	@echo ""
	@echo "🔌 Registration & Probes:"
	@echo "  register-connector  Register B24 connector"
	@echo "  register-webhook    Register MAX webhook"
	@echo "  register-events     Register B24 event handlers"
	@echo "  audit-bindings      Read-only audit of chat bindings"
	@echo "  probe-imconnector   Probe imconnector.send.messages"
	@echo "  probe-max-send      Probe MAX POST /messages"
	@echo "  probe-max-upload    Probe MAX upload flow"
	@echo ""
	@echo "🔍 Monitoring:"
	@echo "  status            Show Docker stats"
	@echo "  ps                Watch Docker processes"
	@echo "  logs              Show all container logs"
	@echo ""
	@echo "🗄  Database (dev):"
	@echo "  db-backup         pg_dump → backup_<ts>.sql"
	@echo "  db-restore        Restore from file: make db-restore file=backup_<ts>.sql"
	@echo ""
	@echo "🧹 Cleanup (только контейнеры этого compose-проекта):"
	@echo "  down              Stop project containers and remove orphans"
	@echo "  down-all          То же с prod-override (docker-compose.server.yml)"
	@echo "  clean             down + удалить тома проекта (БД стирается, спросит подтверждение)"
	@echo ""
	@echo "🛡  Security:"
	@echo "  security-scan     Run dependency vulnerability audit"
	@echo "  security-tests    Run orchestrated security test suite"
	@echo ""
	@echo "💡 Quick start: make dev-node"
	@echo ""

.DEFAULT_GOAL := help

# Development
## NodeJs
dev-node:
	@echo "Starting dev node (Postgres + api-node)"
	COMPOSE_PROFILES=node,db-postgres $(DOCKER_COMPOSE) --env-file .env up --build

# Connector registration / probes
# M26: node напрямую, как `CMD` прод-образа. `pnpm run …` под USER node звал corepack: у node нет
# кэша pnpm (скачан под root при сборке), и в TTY `exec` corepack спрашивал «Do you want to
# continue? [Y/n]» перед скачиванием из registry. Скрипты в package.json — те же `node scripts/…`.
RUN_SCRIPT = $(DOCKER_COMPOSE) exec api-node node scripts
.PHONY: register-connector
register-connector: ## Регистрация Б24-коннектора. Args: ARGS="--unregister" для отката.
	$(RUN_SCRIPT)/register-connector.js $(ARGS)

.PHONY: register-webhook
register-webhook: ## Регистрация MAX webhook. Args: ARGS="--list" / "--unregister" / "--force" (обновить update_types).
	$(RUN_SCRIPT)/register-webhook.js $(ARGS)

.PHONY: register-events
register-events: ## Регистрация B24 event handlers. Args: ARGS="--list" / "--unregister".
	$(RUN_SCRIPT)/register-events.js $(ARGS)

.PHONY: audit-bindings
audit-bindings: ## Read-only аудит привязок: тип чата из MAX, вердикт group/not-group. Args: ARGS="--json".
	$(RUN_SCRIPT)/audit-bindings.js $(ARGS)

.PHONY: probe-imconnector
probe-imconnector: ## Эмпирическая проверка imconnector.send.messages. Args: ARGS="--dry-run".
	$(RUN_SCRIPT)/probe-imconnector-send.js $(ARGS)

.PHONY: probe-max-send
probe-max-send: ## Эмпирическая проверка MAX POST /messages. Args: ARGS="<chatId> --dry-run".
	$(RUN_SCRIPT)/probe-max-send.js $(ARGS)

.PHONY: probe-max-upload
probe-max-upload: ## Эмпирическая проверка MAX upload-флоу. Args: ARGS="<chatId> --dry-run --type=file --file=./doc.pdf".
	$(RUN_SCRIPT)/probe-max-upload.js $(ARGS)

.PHONY: security-scan
security-scan:
	@./scripts/security-scan.sh

.PHONY: security-tests
security-tests:
	@./scripts/security-tests.sh $(SECURITY_TESTS_ARGS)

# Production
# --- M12.8: деплой/бэкап env с локали (оркестраторы поверх scripts/deploy.sh) ---
deploy: ## Деплой дерева на боевой VPS. DRY-RUN по умолчанию; APPLY=1 — боевой (sync→build→migrate→up→health); FROM=<шаг> — догон.
	@echo "🚀 Деплой на VPS через scripts/deploy.sh (APPLY=$(APPLY)$(if $(FROM), FROM=$(FROM)); координаты — scripts/deploy.env)"
	@APPLY=$(APPLY) FROM=$(FROM) ./scripts/deploy.sh deploy

pull-prod-env: ## Затянуть прод-.env с VPS в локальный .env.prod (предварительно бэкап → .env.prod.bak.<ts>).
	@echo "📥 Затягиваю прод-.env с VPS (бэкап локального .env.prod)..."
	@./scripts/deploy.sh pull-env

# --- M8 prod-стек (MAX↔Б24 на VPS): node + db-postgres, prod-override ---
# M26: порядок как у make deploy — образ, БД, миграции на новом образе, затем пересоздание.
# В отличие от deploy, `up` здесь без --no-deps: изменённый сервис database-postgres он
# пересоздал бы под работающим api, до его дренажа (задания в работе упали бы на БД). Для
# изменений сервиса БД — prod-up-db.
prod-up:
	@echo "🚀 Поднимаем prod-стек (node + db-postgres), BUILD_TARGET=production: build → БД → миграции → up..."
	@echo "   Изменения сервиса database-postgres (образ, healthcheck, тома) — make prod-up-db: здесь БД пересоздалась бы под работающим api."
	$(PROD_COMPOSE) build api-node
	$(PROD_COMPOSE) up -d --wait database-postgres
	$(PROD_MIGRATE)
	@echo "⏳ up -d пересоздаёт api: старый процесс сперва дренирует очередь исходящих (до 3 мин)"
	$(PROD_COMPOSE) up -d

# M29: изменения сервиса database-postgres — порядок безопасной остановки: сперва api (`stop`
# ждёт дренажа очереди исходящих, до 3 мин, порт открыт), потом БД. Простой — от выхода
# старого api до старта нового: пересоздание БД и миграции. Образ собирается до остановки.
prod-up-db:
	@echo "🚀 Prod-стек со сменой сервиса БД: build → stop api (дренаж) → БД → миграции → up..."
	$(PROD_COMPOSE) build api-node
	@echo "⏳ stop api-node: старый процесс дренирует очередь исходящих (до 3 мин); дальше api не работает до конца цели"
	$(PROD_COMPOSE) stop api-node
	$(PROD_COMPOSE) up -d --wait database-postgres || { echo "❌ БД не поднялась, api остановлен: исправьте и повторите make prod-up-db"; exit 1; }
	$(PROD_MIGRATE) || { echo "❌ Миграции упали, api остановлен: исправьте и повторите make prod-up-db (прежний api — docker start api)"; exit 1; }
	$(PROD_COMPOSE) up -d

# M29: api по SIGTERM дренирует очередь исходящих с открытым портом — до stop_grace_period
# (180 с, docker-compose.server.yml); postgres compose останавливает после api. С профилями:
# без COMPOSE_PROFILES `down` и `logs` профильные сервисы не видят и молча ничего не делают.
prod-down:
	@echo "🛑 Останавливаем prod-стек (остановка api ждёт дренажа очереди исходящих, до 3 мин)..."
	$(PROD_COMPOSE) down --remove-orphans

prod-logs:
	$(PROD_COMPOSE) logs -f

# M30: логи api — в journald (docker-compose.server.yml) и переживают пересоздание контейнера;
# `prod-logs` видит только текущий. sudo: пользователь деплоя обычно не в группе systemd-journal (без него journalctl
# молча покажет пусто). -o cat — строки pino как есть (JSON), без префикса journald. Без ARGS —
# последние 500 строк, а не вся история за месяцы.
prod-journal:
	sudo journalctl -t maxtob24-api -o cat --no-pager $(or $(ARGS),-n 500)

prod-migrate:
	@echo "🗄  Применяем миграции БД (one-off run --rm на образе api-node; advisory lock — без двойного применения)..."
	$(PROD_MIGRATE)

prod-db-backup:
	@echo "💾 Бэкап prod Postgres → backup_<ts>.sql"
	$(DOCKER_COMPOSE) $(COMPOSE_FILES_PROD) exec -T database-postgres pg_dump -U $${DB_USER:-appuser} $${DB_NAME:-appdb} > backup_$(shell date +%Y%m%d_%H%M%S).sql

# Utils
status:
	docker stats

ps:
	watch -n 2 docker ps

# Только контейнеры, сети и тома ЭТОГО compose-проекта: на общем хосте чужие стеки не трогаем
# (без фильтров по подстроке имени и без глобальных prune). Профили обязательны — без них
# compose профильные сервисы не видит.
DEV_COMPOSE = COMPOSE_PROFILES=node,db-postgres $(DOCKER_COMPOSE)

down:
	@echo "🛑 Останавливаем контейнеры проекта..."
	$(DEV_COMPOSE) down --remove-orphans

down-all:
	$(DEV_COMPOSE) down --remove-orphans
	$(PROD_COMPOSE) down --remove-orphans

clean:
	@printf "🧹 Остановить контейнеры проекта и удалить его тома (БД будет стёрта)? [y/N] "; \
	read ans; [ "$$ans" = y ] || { echo "Отменено"; exit 1; }
	$(DEV_COMPOSE) down --remove-orphans --volumes
	@echo "✓ Очистка завершена"

logs:
	$(DEV_COMPOSE) logs -f

# Database operations (Postgres)
db-backup:
	COMPOSE_PROFILES=db-postgres $(DOCKER_COMPOSE) exec -T database-postgres pg_dump -U $${DB_USER:-appuser} $${DB_NAME:-appdb} > backup_$(shell date +%Y%m%d_%H%M%S).sql

db-restore:
	COMPOSE_PROFILES=db-postgres $(DOCKER_COMPOSE) exec -T database-postgres psql -U $${DB_USER:-appuser} $${DB_NAME:-appdb} < $(file)
