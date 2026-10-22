[← Migrations](migrations.md) · [Назад к README](../../README.md) · [Logging →](logging.md)

# Backend Environment Variables

Все переменные читаются **только** через `loadConfig()` (`backends/node/api/src/shared/config/index.js`). Прямые `process.env.X` в коде модулей запрещены — это упрощает тесты и валидацию.

## Основные

| Переменная | Тип | Default | Используется |
|------------|-----|---------|--------------|
| `DATABASE_URL` (или полный набор `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`) | URL / string | — | `shared/db/pool.js` |
| `API_PORT` (или `PORT`) | int | `8000` | `server.js` (см. ниже про коллизию) |
| `LOG_LEVEL` | enum | `debug` в dev, `info` в prod | `shared/logger/index.js` |
| `NODE_ENV` | enum | `development` | `shared/config/index.js` |

`LOG_LEVEL` — один из `fatal|error|warn|info|debug|trace|silent`. Если значение не в этом наборе, `loadConfig` логирует `warn` и фолбэк на `info`. Старт валит только отсутствие БД (`DATABASE_URL` ИЛИ полный набор `DB_*`); `API_PORT`/`LOG_LEVEL`/`NODE_ENV` имеют дефолты.

> JWT-зоны нет (снята в M13 вместе с роутами стартера `POST /api/getToken` и JWT-only
> `GET /api/health`): `JWT_SECRET`/`JWT_ALGORITHM` не читаются, в старом `.env` их можно удалить.

## Интеграция с MAX и Б24

Без этих переменных старт не падает — `loadConfig` логирует `warn` и продолжает, но мост без них не работает.

| Переменная | Используется | Зачем |
|------------|--------------|-------|
| `MAX_BOT_TOKEN` | `modules/max/maxClient.js` | Токен бота MAX для всех вызовов Bot API |
| `MAX_WEBHOOK_SECRET` | `shared/http/maxSecretMiddleware.js` | Plain-secret `X-Max-Bot-Api-Secret` на `/webhook/max` (**не** HMAC) |
| `MAX_API_BASE_URL` | `modules/max/maxClient.js` | Хост Bot API; default `https://platform-api2.max.ru`, нужен корень Минцифры — см. ниже |
| `MAX_PUBLIC_WEBHOOK_URL` | `scripts/register-webhook.js` | Публичный HTTPS-URL `/webhook/max` для подписки MAX |
| `MAX_WEBHOOK_UPDATE_TYPES` | `scripts/register-webhook.js` (optional override) | Override дефолтного списка update_types, см. ниже |
| `B24_PORTAL` | `modules/b24/b24Client.js` | Домен портала (`your.bitrix24.ru`): REST и OAuth |
| `B24_CLIENT_ID` | `POST /api/install` + OAuth-рефреш (`modules/b24/b24OAuth.js`) | Обязательна для установки (иначе `/api/install` → 503, см. [app-installation.md](app-installation.md)) и auto-refresh `access_token` |
| `B24_CLIENT_SECRET` | `POST /api/install` + OAuth-рефреш (`modules/b24/b24OAuth.js`) | То же |
| `B24_APPLICATION_TOKEN` | `modules/b24/b24Controller.js` | Опционально: env-fallback проверки событий `/webhook/b24`, пока в БД нет токена из install-callback'а. После удаления приложения (`installations.uninstalled_at`, M26) не действует — `503 B24_APP_UNINSTALLED` до переустановки |
| `OL_LINE_ID` | `modules/installations` | Числовой ID Открытой линии, к которой подключается коннектор |
| `B24_CONNECTOR_ID` | `scripts/register-connector.js` | ID коннектора (по умолчанию `max_b24`) |
| `B24_CONNECTOR_NAME` | `scripts/register-connector.js` | Имя коннектора в Контакт-центре (по умолчанию `Макс для групп`) |
| `B24_PLACEMENT_HANDLER_URL` | `scripts/register-connector.js` + `modules/b24/b24Controller.js` | HTTPS-URL для `imconnector.register` PLACEMENT_HANDLER, должен указывать на `GET /b24/connector-settings` |
| `B24_EVENT_HANDLER_URL` | `scripts/register-events.js` | HTTPS-URL `/webhook/b24` для `event.bind` событий Открытых линий и `OnAppUninstall` |

**`MAX_WEBHOOK_UPDATE_TYPES`** — опциональный override дефолтной подписки. Дефолт
(см. `DEFAULTS.maxWebhookUpdateTypes`):
`message_created,message_edited,message_removed,bot_added,bot_removed,user_added,user_removed,chat_title_changed`.
Подписка только на типы, которые контроллер реально обрабатывает; `message_edited`
(правка MAX→OL, [Message Editing](message-editing.md)), `message_removed` (удаление MAX→OL,
[Message Deletion](message-deletion.md)) и `chat_title_changed` (название чата ОЛ,
[Group Title & Icon](group-title-icon.md)) входят в дефолт, т.к. бот MAX по умолчанию на них
не подписан. Новый тип в дефолте в существующую подписку сам не попадает —
`register-webhook --force` ([MAX Webhook Setup](max-webhook-setup.md#обновить-список-событий---force)).

**`MAX_API_BASE_URL` и сертификат Минцифры (M20).** Дефолт — `https://platform-api2.max.ru`,
канонический хост из документации и SDK MAX. Его сертификат выдан **Russian Trusted Sub CA**
(Минцифры); сервер отдаёт промежуточный сертификат сам, а корневого **Russian Trusted Root CA**
в хранилище Node нет. Без него запросы падают с `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.

- В Docker-образе корень подключён: PEM лежит в `backends/node/api/certs/russian_trusted_root_ca.pem`,
  а `Dockerfile` задаёт `NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_root_ca.pem` (обе стадии).
  Node читает эту переменную только при старте процесса, поэтому задавать её в `.env` для
  `pnpm`-запуска на хосте бесполезно: её нужно выставить в окружении shell.
- Источник PEM — `https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt` (Госуслуги).
  SHA-256: `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`,
  действует до 2032-02-27. Проверка: `openssl x509 -in certs/russian_trusted_root_ca.pem -noout -fingerprint -sha256`.
- Переменная действует на **весь** исходящий TLS процесса (Б24, OAuth, скачивание файлов), а не
  только на MAX. Это осознанный компромисс: доверие корню только в клиенте MAX потребовало бы
  отдельного TLS-агента (новая зависимость и риск рассинхрона со встроенным `fetch`).
- Если хост — `platform-api2.max.ru`, а `NODE_EXTRA_CA_CERTS` не задан, `loadConfig` пишет `warn`
  на старте.
- Запасной вариант без CA Минцифры — `MAX_API_BASE_URL=https://botapi.max.ru` (публичный CA,
  на нём мост работал до M20; в официальной документации MAX этот хост не упоминается).
- `https://dev.max.ru/api` (дефолт до M20) — сайт документации, а не API: `GET /me` отдаёт 404.

Регистрация коннектора и фактический формат payload-ов описаны в
[connector-registration.md](connector-registration.md).

### Медиа-флоу (опциональные — есть дефолты)

Все переменные опциональны: при отсутствии берутся дефолты, значения валидируются на старте (невалидное/непозитивное → понятная ошибка `loadConfig`). Доступны через `config.media`.

| Переменная | Default | Назначение |
|------------|---------|------------|
| `MAX_UPLOAD_MAX_RETRIES` | `14` | Попыток `POST /messages` с вложением, пока MAX его обрабатывает (HTTP 400 `attachment.not.ready`, и 429). 14 ≈ 150 с ожидания: файл 60 МБ готов через 16–31 с (live M22) |
| `MAX_UPLOAD_RETRY_BASE_MS` | `1000` | Базовая задержка перед ретраем (мс), растёт экспоненциально (потолок 15с) |
| `MAX_UPLOAD_RETRY_FACTOR` | `2` | Множитель экспоненциального backoff |
| `MEDIA_MAX_BYTES` | `268435456` (256 МиБ) | Лимит размера файла OL → MAX; больше → файл не уходит, оператору — системное сообщение в ОЛ |
| `MEDIA_TRANSFER_TIMEOUT_MS` | `300000` (5 мин) | Дедлайн одной передачи: скачивания из Б24 и заливки в MAX (каждой отдельно), включая тело |
| `MEDIA_CONCURRENCY` | `2` | Сколько файлов передаётся одновременно на процесс (целое ≥ 1). Диск под временные файлы ≤ `MEDIA_MAX_BYTES × MEDIA_CONCURRENCY` |
| `MEDIA_TMP_DIR` | `<os.tmpdir()>/maxtob24-media` | Каталог временных файлов; на старте из него удаляются только свои остатки (`<uuid>.part`) |

Файл идёт потоком через временный файл на диске (память не растёт с размером) и переливается в MAX один раз; повторяется только финальная отправка, без перезаливки бинаря. Исключение (M28): MAX отверг тип вложения (`image`, `video`, `audio`) — тот же временный файл заливается ещё раз как `file`. Тогда заливок две, и время и трафик файла удваиваются (каждая заливка — со своим `MEDIA_TRANSFER_TIMEOUT_MS`). Подробности — [Media Transfer](media-transfer.md).

### Очередь исходящих и остановка (опциональные — есть дефолты)

Обе переменные опциональны; невалидное или непозитивное значение — понятная ошибка `loadConfig`. Доступны через `config.outbound` и `config.shutdown`.

| Переменная | Default | Назначение |
|------------|---------|------------|
| `OUTBOUND_QUEUE_MAX` | `20` | Лимит очереди исходящих одного чата: отправки, правки и удаления OL → MAX одного чата идут строго по очереди. Если в очереди чата уже столько принятых и незавершённых заданий, новое выполняется сразу, без ожидания и вне порядка, с WARN `outbound chat queue full, processing without waiting`; событие не теряется. Это страховка от зависшей передачи, а не рабочий режим: обычная пачка — несколько событий. Целое ≥ 1, больше `1000` зажимается |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `170000` (170 с) | Сколько процесс по `SIGTERM`/`SIGINT` ждёт опустошения очереди исходящих, не закрывая порт. Не уложился — выход с кодом 1; прерванные передачи оповестит следующий старт. Держите меньше `stop_grace_period` контейнера (`180s` в `docker-compose.server.yml`) не меньше чем на 10 с: жёсткий таймер процесса — дедлайн + 5 с на закрытие порта и пула, и `SIGKILL` Docker должен приходить позже него (иначе выход 137 без закрытия пула и без `shutdown complete`) |

Дефолт 170 с покрывает один проход файла 256 МиБ на замеренной полосе VPS (скачивание и заливка — секунды) с полным ожиданием готовности в MAX (~150 с). Перезаливка отвергнутого типа файлом (M28) — второй проход: такая большая передача в дедлайн может не уложиться, и её оповестит следующий старт. Поток очереди, остановка с дренажом и разбор прерванных передач на старте — [Outbound Queue](outbound-queue.md).

### Reply-флоу: двусторонний мост «ответ»

Все опциональны, с дефолтами; невалидное значение целочисленных — понятная ошибка `loadConfig`. Доступны через `config.reply`. Полный разбор фичи — [reply-quoting.md](reply-quoting.md).

| Переменная | Default | Назначение |
|------------|---------|------------|
| `B24_REPLY_RESOLVE_OUTBOUND` | `true` | Звать ли `im.dialog.messages.search` для добора нативного reply OL→MAX (**+1 REST на каждое исходящее**). Принимает `1/0`, `true/false`, `yes/no`, `y/n`, `on/off`; неизвестное → дефолт |
| `REPLY_SEARCH_LIMIT` | `50` | `LIMIT` окна листинга `im.dialog.messages.search`; clamp ≤ `200` (доковый предел). `≤0`/непарсится → ошибка старта |
| `REPLY_QUOTE_MAX_LEN` | `200` | Макс. длина текста родителя в `>>`-цитате MAX→OL (символы) |

### Rate-limit и реальный IP (опциональные — есть дефолты)

Все опциональны, с дефолтами; доступны через `config`. `install` — строгий **общий** потолок
(один бакет на всех: каждый запрос может уйти обменом `refresh_token` на OAuth-сервер с нашим
`client_id`). Вебхуки — щадящие **per-IP** бакеты, у `/webhook/max` и `/webhook/b24` свои.
Подробнее — [Webhooks → Периметр](webhooks.md#периметр-реальный-ip-и-rate-limit).

| Переменная | Default | Назначение |
|------------|---------|------------|
| `TRUST_PROXY` | `loopback, uniquelocal` | Каким адресам доверять `X-Forwarded-For` (express `trust proxy`): CSV из `loopback`/`linklocal`/`uniquelocal` и IP/CIDR, `false` (никому) или число хопов. `true` и `*` отклоняются на старте |
| `RATE_LIMIT_INSTALL_WINDOW_MS` | `900000` (15 мин) | Окно лимита `POST /api/install` |
| `RATE_LIMIT_INSTALL_MAX` | `30` | Максимум запросов `POST /api/install` за окно — на всех вместе |
| `RATE_LIMIT_WEBHOOK_WINDOW_MS` | `60000` (1 мин) | Окно лимитов `/webhook/max` и `/webhook/b24` |
| `RATE_LIMIT_WEBHOOK_MAX` | `600` | Максимум запросов за окно в одном бакете: один IP одного вебхука (~10 rps, с запасом для бёрстов) |

## Порт api-node: `API_PORT` с приоритетом над `PORT`

`loadConfig()` читает порт из `API_PORT` с приоритетом и фолбэком на `PORT`. В `.env.example`
задан `API_PORT=8000` (блок `## MAXTOB24`); в `docker-compose.yml` сервис `api-node`
дополнительно фиксирует `PORT=8000` через `environment:`.

```js
// псевдокод
http.port = API_PORT ?? PORT ?? 8000
```

> **История.** До M12.5 в общем `.env` жил `PORT=3000` для Nuxt-фронта, и приоритет
> `API_PORT` защищал api-node от подхвата чужого `PORT` при локальном `pnpm dev`. Frontend
> снят в M12.5, переменная `PORT=3000` убрана из шаблонов; приоритет `API_PORT` оставлен как
> явный и безопасный механизм выбора порта.

## Где задавать значения

1. **Общий `.env`** (корень репо, не под git) — для docker-compose и локального запуска. Шаблон — `.env.example`.
2. **`.env.test`** (опционально, тоже не под git) — для тестов с реальным Postgres. Шаблон — `backends/node/api/.env.test.example`.

`shared/config/index.js` (`loadDotenvOnce`) загружает `.env` корня репозитория один раз на процесс:

- **путь** — `PROJECT_ROOT_ENV`, корень репо (шесть уровней над `src/shared/config/`). До M26 путь указывал на несуществующий `backends/.env`, и `server.js`/скрипты на хосте корневой `.env` не видели. В контейнере путь ведёт в `/.env`, файла там нет — env даёт `env_file` compose, как и раньше;
- **`override: false`** — env процесса главнее файла: значения `env_file` compose и `export` в shell файл не перебивает;
- **`quiet: true`** — dotenv 17 иначе печатает в stdout `◇ injected env (N) from …` на каждой загрузке, даже без файла: шум в логе `api` и мусор в JSON-выводе скриптов.

**На хосте** (`pnpm db:migrate`, `pnpm <script>`, `node server.js` из `backends/node/api/`) процесс с M26 получает весь корневой `.env` без ручного `export`, включая боевые секреты (`MAX_BOT_TOKEN` бота, общего с продом — см. предупреждение про `register-*` в README). В корневом `.env` `DATABASE_URL` указывает на хост `database` (имя сервиса внутри compose-сети), с хоста он не резолвится. Задавайте `DATABASE_URL` в env процесса — файл его не перебьёт (порт — хост-порт Postgres из `DB_PORT`):

```bash
DATABASE_URL=postgresql://appuser:apppass@localhost:5432/appdb pnpm db:migrate
```

Тестам это не нужно: `tests/globalSetup.js` грузит `.env.test` (с тестовым `DATABASE_URL`) раньше корневого `.env`, обе загрузки — `quiet`.

## См. также

- [Logging](logging.md) — `LOG_LEVEL` и поведение логгера по уровням
- [Migrations](migrations.md) — `DATABASE_URL` / `DB_*` для подключения к Postgres
- [Webhooks](webhooks.md) — секреты вебхуков (`MAX_WEBHOOK_SECRET`, `B24_APPLICATION_TOKEN`)
