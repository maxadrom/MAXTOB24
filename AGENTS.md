# AGENTS.md

> Структурная карта проекта для AI-агентов. Обновляй при существенных изменениях структуры и при добавлении документов в `docs/`.

## Обзор проекта

Кастомный коннектор MAX ↔ Битрикс24 для групповых чатов: webhook MAX → backend (Node.js + Postgres) → Open Lines через `imconnector.*`, и обратно через `OnImConnectorMessageAdd`. Single-tenant MVP. Подробности — в [README.md](README.md).

## Технологический стек

- **Язык backend:** Node.js 24 (ESM), образы `node:24-*`
- **Фреймворк backend:** Express 5
- **База данных:** PostgreSQL (драйвер `pg`)
- **Frontend:** нет — режим «Только API» (headless), проект чисто backend
- **Проверка входящих:** plain-secret `X-Max-Bot-Api-Secret` (MAX), `application_token` + `member_id` (Б24), install-callback — обмен `refresh_token` с ключами приложения
- **Контейнеры:** Docker + Docker Compose
- **Build automation:** Makefile + bash-скрипты
- **Package manager:** pnpm
- **Prod-экспозиция:** общий reverse-proxy (Caddy) + Let's Encrypt на вашем домене
- **Dev TLS-туннель (опц., только dev):** любой HTTPS-туннель с валидным сертификатом на 443

## Структура проекта

```
.
├── backends/
│   └── node/
│       └── api/                # Node.js backend (Express 5, ESM)
│           ├── server.js       # точка входа (bootstrap: config → logger → pool → buildApp → listen; SIGTERM — дренаж очереди исходящих)
│           ├── src/            # app.js + modules/ (max, b24, installations, bindings, messaging) + shared/
│           ├── tests/          # vitest (unit/int/smoke по модулям)
│           ├── scripts/        # register-* / probe-* (one-time / ad-hoc); общий bootstrap — scripts/lib/
│           ├── package.json
│           └── Dockerfile
├── docs/
│   ├── backend/                # архитектура, env, логирование, webhook'и, runbook'и по функциям
│   └── deploy/                 # боевой VPS (vps-prod.md)
├── scripts/                    # операционные bash-скрипты
│   ├── deploy.sh               # деплой на VPS: make deploy (sync→build→migrate→up→health, FROM=<шаг>; --delete только по backends/; up ждёт дренажа старого api) + pull-env
│   ├── deploy.env.example      # шаблон координат VPS (реальные — scripts/deploy.env, gitignored)
│   ├── security-scan.sh
│   └── security-tests.sh
├── docker-compose.yml          # Docker сервисы (api-node, db-postgres)
├── docker-compose.server.yml   # prod-override для VPS
├── makefile                    # ключевые цели: dev-node, down, logs, security-tests, register-*/probe-*, prod-*
├── .env.example                # шаблон dev-окружения
├── .env.prod.example           # шаблон боевого .env
├── CLAUDE.md                   # правила для Claude (коннектор MAX↔Б24)
├── CONTRIBUTING.md             # как вносить изменения: тесты, коммиты, правила архитектуры
├── SECURITY.md                 # как сообщить об уязвимости
├── LICENSE                     # MIT
└── README.md
```

## Ключевые точки входа

| Файл | Назначение |
|------|-----------|
| [backends/node/api/server.js](backends/node/api/server.js) | Точка входа Node.js backend, старт Express и подключение к Postgres |
| [backends/node/api/package.json](backends/node/api/package.json) | Зависимости backend (express, pg, pino, helmet, express-rate-limit, dotenv) |
| [docker-compose.yml](docker-compose.yml) | Сервисы dev-окружения |
| [makefile](makefile) | Команды `dev-node`, `down`, `logs`, `register-*`, `deploy`, `security-tests` (полный список — `make help`) |
| [.env.example](.env.example) | Шаблон переменных окружения (MAX_BOT_TOKEN, B24_*, DATABASE_URL) |

## Документация

| Документ | Путь | Описание |
|----------|------|----------|
| README | [README.md](README.md) | Лендинг коннектора MAX↔Б24: возможности, быстрый старт, HTTP-роуты, навигация по docs/ |
| CLAUDE.md | [CLAUDE.md](CLAUDE.md) | Правила Claude уровня проекта (коннектор MAX↔Б24) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) | Тесты, conventional commits, правила архитектуры, чек-лист PR |
| Security | [SECURITY.md](SECURITY.md) | Как сообщить об уязвимости |
| Backend Architecture | [docs/backend/architecture.md](docs/backend/architecture.md) | Слои/модули backend, добавление модуля за 5 шагов |
| Backend Migrations | [docs/backend/migrations.md](docs/backend/migrations.md) | SQL-runner, имена миграций, миграция до старта нового кода (только расширяющие), advisory lock, запуск на хосте, тестовая БД |
| Backend Env | [docs/backend/env.md](docs/backend/env.md) | Полная таблица env-переменных и решение коллизии `PORT`; загрузка корневого `.env` (на хосте — `DATABASE_URL` в env процесса) |
| Backend Logging | [docs/backend/logging.md](docs/backend/logging.md) | Формат pino, `requestId`, redact-список |
| Backend Webhooks | [docs/backend/webhooks.md](docs/backend/webhooks.md) | Паттерн webhook'ов: `X-Max-Bot-Api-Secret`, `application_token`, ответы |
| App Installation | [docs/backend/app-installation.md](docs/backend/app-installation.md) | Runbook install-callback `POST /api/install`: обмен `refresh_token` как доказательство подлинности, коды ответов, первая установка, негативные пробы; удаление приложения `ONAPPUNINSTALL` (токены → NULL, `uninstalled_at`, очистка при `CLEAN=1` через координатор, миграция 0013) и переустановка; `register-events` |
| Connector Registration | [docs/backend/connector-registration.md](docs/backend/connector-registration.md) | Runbook `scripts/register-connector.js`, prerequisites, troubleshooting |
| MAX Webhook Setup | [docs/backend/max-webhook-setup.md](docs/backend/max-webhook-setup.md) | Runbook `scripts/register-webhook.js`, troubleshooting `SECRET_MISSING/INVALID` |
| Inbound Routing | [docs/backend/inbound-routing.md](docs/backend/inbound-routing.md) | Runbook inbound MAX → Open Lines: авто-онбординг (атомарный upsert, миграция 0012), только группы (личка — подсказка, канал — тишина), ключ `nomid:` для сообщений без mid, `make audit-bindings`, acceptance, skip-вердикты `routeInbound` |
| Outbound Routing | [docs/backend/outbound-routing.md](docs/backend/outbound-routing.md) | Runbook outbound Open Lines → MAX: acceptance, дубль-проверка, BB-strip, skip-вердикты `routeOutbound`; `notifyOperator` — системное сообщение оператору о неудаче отправки, правки, удаления (вне HTTP-контекста, без `REPLY_ID`), installation из резолва привязки |
| Formatting + Delivery | [docs/backend/formatting-delivery.md](docs/backend/formatting-delivery.md) | Runbook BB↔markdown конвертация, `imconnector.send.status.delivery` (best-effort), inbound scope, troubleshooting |
| Admin Health-check | [docs/backend/admin-healthcheck.md](docs/backend/admin-healthcheck.md) | Runbook bot_added/user_added(self) → `read_all_messages` проверка, dedup-guard, гарантия no-5xx, live-acceptance |
| Media Transfer | [docs/backend/media-transfer.md](docs/backend/media-transfer.md) | Передача файлов MAX ↔ OL в обе стороны: inbound `message.files`, outbound upload-флоу, retry, `MEDIA_MAX_BYTES`, known-limitation; allowlist картинок (без HEIC, 7680 px по стороне) и перезаливка файлом при отказе MAX (`error_data` → `maxCode`, `isMediaRejectedError`); входящие голосовые (inline аудио-плеер) |
| Membership Notifications | [docs/backend/group-membership-notifications.md](docs/backend/group-membership-notifications.md) | Системные уведомления о вступлении/выходе участников группы: `routeLifecycle` → `im.message.add` (`SYSTEM='Y'`), `b24_chat_id` (миграция 0007), синтетический дедуп-ключ, best-effort |
| Group Title & Icon | [docs/backend/group-title-icon.md](docs/backend/group-title-icon.md) | Название и иконка MAX-группы в чате ОЛ: интро от псевдо-пользователя `group:<chatId>` (аватар чата = иконка), `imconnector.chat.name.set` после доставки (pending при закрытой сессии, `ol_chat_title`, миграция 0010), `chat_title_changed` → `routeChatTitleChanged`, `register-webhook --force`; ссылка на группу системным сообщением (`im.message.add SYSTEM=Y`, ключ `group-link:<chatId>:<hash>`: интро, опенер, ленивый шаг для старых привязок — память + SELECT `hasInboundKeyPrefix`); `CHAT_RENAMING_FAILED` → `imopenlines.dialog.get` по `CHAT_ID` (поле 6 `entity_data_1`) → `already` / `pending` / флаг опенера (M27) |
| Group Session Opener | [docs/backend/group-session-opener.md](docs/backend/group-session-opener.md) | «Группа» — клиент каждой сессии ОЛ: `OnImConnectorDialogFinish` → `routeDialogFinish` (флаг `ol_closed_session_id`, миграция 0011) → опенер «Новое обращение из группы…» от `group:<chatId>` перед следующим входящим; `register-events`; второй сигнал закрытия — `CHAT_RENAMING_FAILED` + поле 6 = 0 только в `routeChatTitleChanged`, флаг `0` при неизвестной сессии (M27) |
| Reply / Quoting | [docs/backend/reply-quoting.md](docs/backend/reply-quoting.md) | Двусторонний мост «ответ»: `>>`-цитата MAX→OL (`buildReplyQuoteBbcode`), нативный reply OL→MAX (`im.dialog.messages.search` → `resolveReplyContext` → `_resolveReplyMaxMid`), env `B24_REPLY_RESOLVE_OUTBOUND`/`REPLY_SEARCH_LIMIT`/`REPLY_QUOTE_MAX_LEN`, best-effort |
| Message Editing | [docs/backend/message-editing.md](docs/backend/message-editing.md) | Двусторонний мост правки текста: `routeInboundEdit` (`imconnector.update.messages`, маркер «Изменено») / `routeOutboundEdit` (`PUT /messages`: `success:false` — ошибка, 429 — один повтор; `edit-failed`/`no-maxmid`/`edit-error` → оповещение оператора), синтетический ключ (in `edit:<mid>:<ts>` / out `edit:<b24MsgId>:<хеш текста>`), эхо-защита |
| Message Deletion | [docs/backend/message-deletion.md](docs/backend/message-deletion.md) | Двусторонний мост удаления: `routeInboundDelete` (`imconnector.delete.messages`) / `routeOutboundDelete` (`DELETE /messages`; `success:false` на все → `max-window`, лимита по давности нет — live удалено и через 63 ч; `delete-failed`, «не полностью» по журналу, `delete-error` → оповещение оператора), синтетический ключ `delete:<id>`; удаление во время заливки ждёт её в очереди чата |
| Outbound Queue | [docs/backend/outbound-queue.md](docs/backend/outbound-queue.md) | Очередь исходящих OL → MAX по чату (M29): `routeOutboundQueued` → claim строки `job:<ключ операции>` (`status='in_progress'`, без миграции; конфликт → `duplicate-in-progress`) → FIFO чата (`KeyedQueue`, лимит `OUTBOUND_QUEUE_MAX` с обходом) → прежний маршрут → снятие строки; ответ Б24 после доставки; остановка `gracefulShutdown` (дренаж с открытым портом до `SHUTDOWN_DRAIN_TIMEOUT_MS`, `Connection: close`, код выхода), `stop_grace_period: 180s`, reboot ~90 с; разбор прерванных после `listen` (`recoverInterruptedOutbound`: дописать части, повторить удаление, оповещение «мост перезапускался» без `REPLY_ID`); логи, troubleshooting |
| Deploy: VPS prod | [docs/deploy/vps-prod.md](docs/deploy/vps-prod.md) | Runbook боевого VPS: Caddy + TLS, `make deploy`/`make pull-prod-env` (миграции до старта кода, догон `FROM`, сироты: `--delete` только по `backends/`; шаг `up` ждёт дренажа, первый выкат с `stop_grace_period`), prod-compose, бэкап Postgres, рестарт `api-node` и reboot, переезд на другой хост |

## Правила для агента

- **Декомпозируй shell-команды.** Не использовать составные команды с `&&` для git-операций над shared-state.
  - ❌ Неправильно: `git checkout main && git pull`
  - ✅ Правильно: сначала `git checkout main`, затем `git pull origin main`
- **MCP postgres** (если подключён в локальном `.mcp.json`) требует `DATABASE_URL` в `.env`.
- **Внешние API-ссылки** проверять через MCP `b24-dev-mcp` (для Битрикс24) и официальную доку MAX (`dev.max.ru/docs-api/`) перед использованием.
- **Webhook MAX** обязательно HTTPS на 443 с валидным сертификатом. Для dev — любой HTTPS-туннель до `api-node`.
