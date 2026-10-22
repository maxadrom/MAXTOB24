# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# MAX ↔ Битрикс24 Connector Guide

Кастомный коннектор, связывающий групповые чаты мессенджера **MAX** (`dev.max.ru`) с **Открытыми линиями Битрикс24**. Backend на Node.js + Express 5 + PostgreSQL. Single-tenant MVP, режим «Только API» (headless), без frontend.

Полный контекст: [README.md](README.md) · карта проекта и список документации — [AGENTS.md](AGENTS.md) · [docs/backend/architecture.md](docs/backend/architecture.md).

## Язык

Рассуждения (think/reasoning) и любые обращения к пользователю — на русском. Правило действует и в подагентах: явно передавай его в их контекст.

## Commands

- **Поднять окружение**: `make dev-node` (Postgres + `api-node`, контейнер `api`, порт 8000)
- **Миграции БД**: `docker compose --profile node exec api-node pnpm db:migrate` (SQL-файлы `src/shared/db/migrations/NNNN_*.sql`, см. [docs/backend/migrations.md](docs/backend/migrations.md))
- **Тесты** — только из `backends/node/api/` (из корня репо vitest не находится):
  - все: `pnpm test` (vitest, `--no-file-parallelism` обязателен — DB-тесты делят один Postgres); `pnpm test:watch`
  - один файл / один тест: `pnpm exec vitest run --no-file-parallelism tests/max/maxService.edit.test.js -t "<имя теста>"`
- **Остановить**: `make down` · **Логи**: `make logs`
- **Безопасность**: `make security-tests`, `make security-scan` (аудит зависимостей)
- **Регистрация/проба** (one-time, через контейнер; аргументы — `ARGS="..."`, напр. `ARGS="--list"`/`"--unregister"`/`"--dry-run"`): `make register-connector`, `make register-webhook`, `make register-events`, `make audit-bindings` (read-only), `make probe-imconnector`, `make probe-max-send`, `make probe-max-upload`
- **Прод**: деплой с локали — `make deploy` (dry-run) / `make deploy APPLY=1` (боевой: `sync → build → migrate → up → health` — миграции в one-off `compose run --rm` до пересоздания `api`; после сбоя — догон `FROM=<шаг>`; корень rsync'ом без `--delete`, `--delete` только по `backends/`); бэкап прод-`.env` — `make pull-prod-env`. Примитивы на VPS: `make prod-up`, `make prod-migrate`, `make prod-logs`, `make prod-journal` (история логов `api` из journald через пересоздания, M30). Координаты VPS — в `scripts/deploy.env` (см. `scripts/deploy.env.example`, `docs/deploy/vps-prod.md`).

Линтера/форматтера в проекте нет.

### Тесты и БД

- `tests/globalSetup.js` грузит `backends/node/api/.env.test` (если есть), затем корневой `.env`; при доступном Postgres создаёт БД из `DATABASE_URL` и прогоняет миграции. Если БД недоступна — `SKIP_DB_TESTS=1`, и DB-тесты **скипаются, а не падают**.
- DB-зависимые тесты — суффиксы `.smoke.test.js` / `.int.test.js` / `.integration.test.js`, гейт через `shouldSkipDb()` из `tests/helpers/db.js`; между тестами `truncateAll(pool)`.
- В корневом `.env` хост БД `database` (docker-only), поэтому с хоста DB-тесты по умолчанию скипаются. Чтобы их прогнать — `.env.test` с отдельной БД, напр. `DATABASE_URL=postgresql://appuser:apppass@localhost:5432/appdb_test` (НЕ указывать рабочую `appdb`: тесты её транкейтят).
- Внешние HTTP (MAX, Б24) в тестах мокаются через подменённый `fetch`; `buildApp` принимает тестовые seam'ы (`deps.exchangeRefreshToken` и т.п.).

## Architecture

Backend организован по паттерну **Structured Modules (Vertical Slices by Entity)** — корень `backends/node/api/`. Подробности и правила зависимостей — в [docs/backend/architecture.md](docs/backend/architecture.md).

- **`max/`** — адаптер MAX Bot API (webhook handler, отправка/правка/удаление сообщений, upload-флоу файлов).
- **`b24/`** — адаптер Б24 (`imconnector.*`, обработка `OnImConnectorMessageAdd` и др. событий, BB-код↔markdown в `bbcode.js`).
- **`installations/`** — токены портала, `OL_LINE_ID`, `connector_id`, install-callback, пометка удаления приложения (`uninstalled_at`, M26).
- **`bindings/`** — mapping `max_chat ↔ connector_chat`, `participant_map`; без HTTP-роутов. Привязка авто-создаётся на первом входящем сообщении.
- **`messaging/`** — координатор inbound/outbound (`routeInbound`/`routeOutbound` + edit/delete/lifecycle-варианты), идемпотентность через `message_log`. Исходящие из вебхука — через `routeOutboundQueued` (очередь по чату, строка `job:` «в процессе», разбор прерванных на старте — M29); оповещения оператора — `notifyOperator` + тексты в `operatorNotices.js` (M28).
- **`shared/`** — cross-cutting: pg pool + миграции, config, logger (pino), HTTP middleware (secret-проверка, rate-limit, SSRF-guard, errorHandler), `cli/isInvokedDirectly`, `concurrency/` (семафор передач медиа, `KeyedQueue` — FIFO по ключу), `lifecycle/gracefulShutdown` (остановка с дренажом очереди).
- **`scripts/`** (one-time `register-*`/`probe-*`) — зависимости собирает `scripts/lib/bootstrap.js` (`scriptContext`, `b24Graph`, `requireInstallation`, `maxClientFor`, `runCli`); новый скрипт — через него, не копией.

**Ключевое правило:** адаптеры `max/` и `b24/` НИКОГДА не вызывают друг друга напрямую — только через `messagingService`, где сосредоточены идемпотентность и audit-лог.

**Композиция:** вся сборка — в `src/app.js` (`buildApp(config, { pool, logger })`), конструкторная DI без контейнера; `server.js` — только bootstrap. Цикл адаптер ↔ координатор разрывается так: `MaxService`/`B24Service` создаются с `messagingService: null`, затем получают его через `setMessagingService()`. В `app.js` нет `process.env` — только `config`.

**HTTP-поверхность** (полный список — `ROUTES_MOUNTED` в `app.js`): `GET /`, `GET /health`, `POST /api/install`, `POST /webhook/max`, `POST /webhook/b24`, `GET /b24/connector-settings`. Каждой функции моста соответствует runbook в `docs/backend/` (индекс — таблица в AGENTS.md).

## Development Guidelines

1. **Backend (Node.js, ESM):**
   - Поток зависимостей строго вниз: Controller → Service → Repository → DB.
   - Один владелец на таблицу; кросс-модульный доступ — только через сервис-фасад модуля, не через прямой SQL.
   - Rich domain models (`ChatBinding`, `MessageLogEntry`) — с поведением, не bags-of-data.
   - Все обязательные env (`MAX_BOT_TOKEN`, `MAX_WEBHOOK_SECRET`, `B24_*`, `DATABASE_URL`, ...) описаны в `shared/config/schema.js` и валидируются на старте (`shared/config/index.js`); полная таблица — [docs/backend/env.md](docs/backend/env.md). Новую env-переменную добавлять туда же.
   - Структурное логирование (pino) с `requestId`; секреты — только в `.env`, никогда в коде.
   - `.env` попадает в контейнер через `env_file` только при его создании: после правки `.env` — `docker compose --profile node up -d --force-recreate api-node` (`restart` env не перечитывает).
   - На хосте (`pnpm <script>`, `node server.js` из `backends/node/api/`) корневой `.env` читается сам (`loadDotenvOnce`, `override: false`, M26): `DATABASE_URL` с хостом `database` с хоста не резолвится — задавать его в env процесса ([docs/backend/env.md](docs/backend/env.md#где-задавать-значения)).
2. **Безопасность входящих запросов:**
   - `/webhook/max` — проверка `X-Max-Bot-Api-Secret` (plain-secret, не HMAC).
   - `/webhook/b24` — проверка `auth[application_token]` (приоритет: токен из БД > env-fallback `B24_APPLICATION_TOKEN`).
   - `/api/install` — публичный, под строгим rate-limit; подлинность проверяет `installationsService`: домен = `B24_PORTAL`, `refresh_token` из `ONAPPINSTALL` обменивается на OAuth-сервере с `B24_CLIENT_ID/SECRET` (пара нашего приложения, `client_endpoint` = портал), пишется новая пара. Без client creds — 503. Runbook — [docs/backend/app-installation.md](docs/backend/app-installation.md).
   - `/webhook/b24` дополнительно сверяет `auth[member_id]` с `installations.b24_member_id`, если он сохранён.
   - После удаления приложения (`ONAPPUNINSTALL`, M26: токены → NULL, `installations.uninstalled_at`) `/webhook/b24` отвечает `503 B24_APP_UNINSTALLED` до проверки токена — env-fallback не действует; онбординг новых групп — 503. Снимает пометку только переустановка (`/api/install`).
   - JWT-зоны нет (удалена в M13), `JWT_*` из конфига убраны — не возвращать JWT-роуты.
3. **Идемпотентность:** дубль `body.mid` (входящие) или message id Б24 (исходящие) не создаёт повторной записи — dedup в `message_log` (`INSERT … ON CONFLICT DO NOTHING`) внутри `messagingService` — новый маршрут строится на общем каркасе `_once`, не ручной копией. Правки/удаления/системные события используют синтетические ключи (`edit:<mid>:<ts>`, `delete:<id>` и т.п.), чтобы не схлопнуться с оригиналом. Исходящие OL → MAX из вебхука идут **только** через `routeOutboundQueued` (FIFO по чату + строка `job:` в `message_log`), не прямым вызовом `routeOutbound`/`Edit`/`Delete`: иначе правка/удаление обгонят заливающийся файл, а прерванная рестартом передача не будет видна оператору. Новый исходящий маршрут встраивается в эту очередь.
4. **Ошибки апстрима:** HTTP-статус MAX/Б24 не кладём в `err.status` — его `errorHandler` отдаёт ответом вебхука, и 4xx отключил бы ретраи (`MaxApiError.httpStatus`, `B24ApiError.httpStatus`).
5. **Best-effort:** вспомогательные шаги (статус доставки, reply-резолв, уведомления о вступлении, удаление) не должны ронять основной поток и отдавать 5xx — неудача логируется и даёт skip-вердикт.
6. **Транспорт:** только webhook от MAX (`POST /subscriptions`), НЕ long-polling `/updates`: по доке MAX `/updates` — только для разработки и помечает события прочитанными (теряются при рестарте), а webhook даёт ретраи на стороне MAX и не требует фонового воркера. Webhook MAX требует HTTPS на 443 с валидным сертификатом.
7. **Факты внешних API** проверять через MCP `b24-dev-mcp` (Битрикс24) и `dev.max.ru/docs-api/` (MAX) до использования.
