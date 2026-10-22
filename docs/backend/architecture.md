[Назад к README](../../README.md) · [Migrations →](migrations.md)

# Backend Architecture

Этот документ — прикладная сводка по архитектуре backend MAX↔Б24: корень, слои, правила зависимостей и как добавить модуль.

## Корень и слои

- **Корень backend:** `backends/node/api/`
- **Точка входа:** `backends/node/api/server.js` (только bootstrap: config → logger → pool → `buildApp` → `listen`; после `listen` — разбор прерванных исходящих, по `SIGTERM`/`SIGINT` — остановка с дренажом, M29)
- **Фабрика приложения:** `backends/node/api/src/app.js` (`buildApp(config, { pool, logger })`)
- **Исходники:** `backends/node/api/src/`

```
src/
├── modules/
│   ├── installations/   # токены портала, OL_LINE_ID, connector_id, пометка удаления приложения (uninstalled_at, M26)
│   ├── bindings/        # max_chat ↔ connector_chat + participant_map
│   ├── messaging/       # координатор inbound/outbound + идемпотентность через message_log (_once)
│   ├── max/             # адаптер MAX Bot API
│   └── b24/             # адаптер Bitrix24 (imconnector + imopenlines)
├── shared/
│   ├── config/          # env-loader с валидацией (корневой .env на хосте, quiet dotenv — M26)
│   ├── logger/          # pino + pino-http
│   ├── db/              # pg Pool + runMigrations (под advisory lock, M26) + migrations/*.sql
│   ├── crypto/          # hmac, contentHash
│   ├── concurrency/     # semaphore (передачи медиа, M22), keyedQueue (очередь исходящих по чату, M29)
│   ├── lifecycle/       # gracefulShutdown — остановка с дренажом очереди исходящих (M29)
│   ├── media/           # временные файлы медиа, MediaTooLargeError (M22)
│   ├── cli/             # isInvokedDirectly (CLI-обёртки scripts/* и runMigrations)
│   └── http/            # rawBody, maxSecretMiddleware (для /webhook/max), rateLimit, ssrfGuard, urlHost, errorHandler + errorResponse (конверт ошибки ответа), domainErrors, health (hmacMiddleware — резерв, сейчас не подключён)
└── app.js
```

Типовой модуль состоит из:

- `<module>Controller.js` — тонкий, парсит `req`/делегирует в сервис. **Есть не у каждого модуля:** `bindings/` — внутренний координатор без HTTP-роутов (вызывается из `messagingService`), контроллера у него нет.
- `<module>Service.js` — use-case, оркестрирует репозитории и адаптеры
- `<module>Repository.js` — единственное место SQL для таблицы модуля (у `bindings/` их два: `bindingsRepository.js` + `participantMapRepository.js`)
- `<module>Client.js` — внешний HTTP-адаптер модуля-адаптера (`maxClient.js`, `b24Client.js`); инжектится в Service
- `models/*.js` — rich domain models (методы инвариантов и переходов статусов)

Адаптерные модули `max/`/`b24/` дополнительно держат вспомогательные файлы рядом с сервисом (`b24/bbcode.js` — BB-код↔markdown и подпись к медиа, `b24/b24Constants.js` — константы, `b24/b24OAuth.js` — обмен `refresh_token` на OAuth-сервере (рефреш и проверка install-callback'а; в `installations` приходит через DI-шов `app.js`, M19), `max/maxApiError.js` — ошибка MAX: non-2xx, нет ответа, неполный ответ, отказ `success:false`). DTO-модели лежат в `models/`: `max/models/MaxUpdate.js` + `MaxMessage.js`, `b24/models/OpenLineEvent.js` + `ConnectorMessage.js`. Форму ответов внешнего API знает только адаптер: фасад `maxService` отдаёт координатору разобранное (`{ maxMid, timestampMs }`, `{ deleted, maxMessage }`), а не сырой JSON MAX.

`MaxApiError` хранит HTTP-статус апстрима в `httpStatus`, **не** в `status`, и не наследует `DomainError`: `errorHandler` превращает `err.status` в статус ответа нашего вебхука, а 4xx от MAX не должен становиться 4xx для MAX/Б24 (MAX перестал бы ретраить). `B24ApiError` (наследник `DomainError`) по той же причине всегда отдаёт `status: 502`, а статус портала хранит в `httpStatus`. С M22 `MaxApiError` покрывает все сбои транспорта MAX (`kind`: `http` / `timeout` / `network` / `protocol`; с M28 ещё `rejected` — HTTP 200 с `success:false` у правки): по нему координатор отличает недоставку в MAX (200 + системное сообщение оператору — Б24 событие не повторяет) от ошибок БД и багов (500 у отправки, вердикт у правки и удаления; оператору — best-effort «могло не дойти», M28). Поле `stage` (M28) — шаг upload-флоу, на котором упала заливка; по нему `maxService` решает, перезалить ли отвергнутое вложение файлом.

Общие примитивы в `shared/`: `shared/media/` — временные файлы медиа (`MediaTempFiles`) и `MediaTooLargeError`; `shared/concurrency/semaphore.js` — счётный семафор передач медиа (M22); `shared/concurrency/keyedQueue.js` — очередь с FIFO по ключу, лимитом на ключ (сверх него — без ожидания) и `drain(timeoutMs)` (M29); `shared/lifecycle/gracefulShutdown.js` — остановка процесса: дренаж очереди с открытым портом, `server.close`, `pool.end`, код выхода (M29).

**Очередь исходящих и рантайм-ручки (M29).** `buildApp` создаёт одну `KeyedQueue` на процесс (лимит — `config.outbound.queueMax`; конфиг без секции, как в тестах, берёт дефолт) и отдаёт её `MessagingService`: исходящие OL → MAX из вебхука идут через `routeOutboundQueued` — очередь по чату поверх прежних `routeOutbound`/`Edit`/`Delete`. Наружу `buildApp` по-прежнему отдаёт только `app`; то, что нужно `server.js` и smoke-тестам, лежит в `app.locals.outbound` = `{ queue, recoverInterrupted }`: очередь дренирует остановка, `recoverInterrupted({ createdBefore, signal })` разбирает строки `job:`, оставленные прошлым процессом. Runbook — [Outbound Queue](outbound-queue.md).

One-time скрипты (`backends/node/api/scripts/*`) собирают зависимости через `scripts/lib/bootstrap.js`: `scriptContext` (config + logger), `b24Graph` (pool → installations → B24Client), `requireInstallation` (через фасад `installationsService.findByPortal`; после удаления приложения Б24 — ошибка с подсказкой переустановить, M26), `maxClientFor`, `runCli` (коды выхода 0 / 2 для `{ ok:false }` у проб / 1 на исключение). Ключи `deps` — seam'ы smoke-тестов.

## Как добавить новый модуль за 5 шагов

1. **Создать каталог** `src/modules/<name>/` с подкаталогом `models/`.
2. **Описать модель** — класс с конструктором, `fromRow(row)` и поведением (методы инвариантов и переходов статусов).
3. **Написать репозиторий** — SQL только здесь, методы возвращают модель через `Model.fromRow`.
4. **Сервис** — публичный API модуля. Бросает `DomainError` подкласс, не возвращает `null` для ошибок.
5. **Подключить в `src/app.js`**:
    - Создать инстансы (`new XRepository(pool, logger.child(...))` → `new XService(...)`).
    - Создать контроллер и подвесить роуты.
    - Зависимости передавать через конструктор (DI без контейнера).

## Правила зависимостей

- `Controller → Service → Repository → DB` (строго вниз).
- Между модулями — **только через сервис-фасад**. Кросс-модульные `require('../other/Repository')` запрещены.
- `messagingService` — **единственный координатор** межмодульных переходов. Адаптеры (`max/`, `b24/`) не вызывают друг друга напрямую.
  - Удаление приложения Б24 (M26) — тоже через координатор: `b24Service.handleAppUninstall` → `installationsService.markUninstalled()` (токены → `NULL`, `uninstalled_at`) → при `CLEAN=1` `messagingService.purgeBridgeData()` → `bindingsService.purgeAll()`. `participant_map` и `message_log` уходят по FK `ON DELETE CASCADE` вместе с привязками — других путей к журналу у `bindings/` нет. Новых межмодульных связей это не добавило.
- `shared/` импортируется откуда угодно. `shared/` НИЧЕГО не импортирует из модулей.

## Инварианты

- **HTTP middleware order в `app.js`:**
  1. `helmet` (security-заголовки; CSP и frameguard отключены — плейсхолдер открывается в iframe Б24)
  2. `pino-http` (request-id + req.log)
  3. `express.json({ limit: '256kb', verify: verifyRawBody })` — раздаёт `req.rawBody` для HMAC/secret-проверки
  4. `express.urlencoded({ extended: true, limit: '256kb' })` — form-style payload'ы (install-handshake Б24)
  5. `cors()` — только origin портала `B24_PORTAL` (если не задан — кросс-оригин выключен)
  6. роуты; rate-limit и secret-middleware — на уровне конкретных роутов (`/api/install`, `/webhook/*`)
  7. `errorHandler` (последним)
- **JWT-зоны нет** (снята в M13): `/api/getToken`, `jwtMiddleware`, `crypto/jwt` удалены, `JWT_*` не читаются.
- **HMAC проверяется по `req.rawBody`**, не по распарсенному `req.body`. См. [webhooks.md](webhooks.md).
- **Конструкторная DI**, без DI-контейнера. Логгер — child через `logger.child({ module: 'x' })`.

## См. также

- [Migrations](migrations.md) — SQL-runner и список таблиц, которыми владеют модули
- [Webhooks](webhooks.md) — проверка `req.rawBody` и идемпотентность в `messagingService`
- [Environment](env.md) — env-loader `shared/config/` и порядок загрузки
- [Outbound Queue](outbound-queue.md) — очередь исходящих по чату, остановка с дренажом, разбор прерванных на старте
