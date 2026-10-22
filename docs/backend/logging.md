[← Environment](env.md) · [Назад к README](../../README.md) · [Webhooks →](webhooks.md)

# Backend Logging

Структурный логгер на `pino`. Все запросы получают `requestId` через `pino-http`.

## Формат

- **Production** (`NODE_ENV=production`): JSON в `stdout`, обработка — стандартными tail/log shipper.
- **Dev** (`NODE_ENV !== production`): `pino-pretty` (цветной, человекочитаемый).

## requestId

`pino-http` вешает `req.id` и `req.log`:

- если в заголовке `X-Request-Id` пришёл валидный id (string, ≤200 символов) — используется как есть;
- иначе генерится `crypto.randomUUID()`.

## Access-лог

`pino-http` пишет строку завершения на каждый запрос: `req.{id, method, url, ip, remoteAddress}`,
`res.statusCode` и `responseTime` (мс). Строка пишется, когда ответ ушёл: у `POST /webhook/b24` —
после доставки в MAX, а у события, ждавшего очереди своего чата (M29), — после передачи, за которой
оно стояло. С M20:

- `req.ip` — адрес клиента с учётом `trust proxy` (`TRUST_PROXY`). За Caddy → docker-proxy это
  реальный публичный IP из `X-Forwarded-For`.
- `req.remoteAddress` — адрес сокета. За docker-proxy это шлюз docker-сети (`172.x.0.1`).

Трафик почти целиком server-to-server (MAX, Б24). IP оператора попадает в лог, только когда он
открывает `/b24/connector-settings`.

В контроллерах используем `const log = req.log ?? this.logger;` и пишем через него — `requestId` автоматически попадёт во все записи запроса.

## Child-логгеры

Каждый модуль получает свой `child` с биндингом `module`:

```js
const log = logger.child({ module: 'max' });
log.info({ chatId: '123' }, 'max webhook received');
```

В сериализованном выводе будет:

```json
{ "level": 30, "module": "max", "chatId": "123", "msg": "max webhook received" }
```

## customLogLevel

`pino-http` подбирает уровень по статус-коду ответа:

- `5xx` или throw → `error`
- `4xx` → `warn`
- иначе → `info`

## Что НЕ попадает в лог (redact)

`shared/logger/index.js` экспортирует `DEFAULT_REDACT_PATHS`:

```
req.headers.authorization
req.headers.cookie
headers.authorization
headers.cookie
*.password
*.token
*.secret
*.access_token
*.refresh_token
*.application_token
config.jwt.secret
config.db.password
```

Замена — `[redacted]`.

**Также не логируем сами по конвенции** (нет автоматики, но это правило для авторов):

- тела сообщений MAX в `info` — только в `debug` и без `body.text` (только метаданные: chat_id, mid, sender_id);
- сами HMAC-подписи в логах (только сам факт `HMAC verification failed`).

## Исходящие, остановка и старт (M29)

Строки очереди исходящих, остановки с дренажом и разбора прерванных передач. Полные поля и
что делать — в [Outbound Queue](outbound-queue.md#логи).

| Уровень | Строка | Когда |
|---|---|---|
| INFO | `outbound job done` | задание исходящего выполнено: `op`, `connectorChatId`, `b24MsgId`, `verdict`, `queuedMs` (ожидание очереди чата), `durationMs`, `bypass` |
| ERROR | `outbound job failed` | внутренняя ошибка отправки (БД, баг) → 500 |
| WARN | `outbound chat queue full, processing without waiting` | очередь чата полна (`OUTBOUND_QUEUE_MAX`), задание идёт без ожидания |
| WARN | `routeOutbound: duplicate-in-progress, skipping` (и `routeOutboundEdit:` / `routeOutboundDelete:`) | повтор события, пока первое выполняется |
| ERROR | `routeOutbound: outbound job claim failed, not queued` | БД отказала до постановки в очередь |
| WARN | `outbound job release failed, retrying in background` | строка задания не снялась (БД), повторы в фоне |
| INFO | `outbound job released after retry` | строку снял повтор |
| ERROR | `outbound job release gave up (will be reported on next start)` | повторы исчерпаны, строку разберёт следующий старт |
| INFO | `shutdown requested: draining outbound queue (still listening)` | `SIGTERM`/`SIGINT`: дренаж, порт открыт (`pending`, `requests` — HTTP-запросов в работе) |
| INFO | `outbound queue drained` | очередь опустела, запросов в работе нет |
| ERROR | `drain timeout: interrupted jobs will be reported on next start` | дедлайн `SHUTDOWN_DRAIN_TIMEOUT_MS` |
| INFO | `http server closed`, `pg pool closed`, `shutdown complete` | порт и пул закрыты, выход (`code` 0 или 1) |
| ERROR | `graceful shutdown timeout — force exit` | закрытие повисло, жёсткий таймер |
| WARN | `shutdown: repeated signal ignored, still draining` | повторный `SIGTERM` (ещё один `docker stop`): дренаж продолжается |
| WARN | `shutdown: second signal, force exit` | `SIGINT` во время остановки (второй Ctrl+C): выход 1 |
| INFO | `interrupted outbound jobs found` | на старте найдены передачи, прерванные прошлым процессом (`count`) |
| WARN / ERROR | `interrupted outbound lookup failed, retrying` / `interrupted outbound lookup gave up (rows wait for next start)` | БД недоступна на старте |
| ERROR | `recovery notice failed, giving up` | оповещение о прерванной передаче не ушло после 3 попыток |
| INFO | `interrupted outbound recovered` | итог разбора: `total`, `notified`, `completed`, `dropped`, `failedNotify`, `failed` |
| INFO | `interrupted outbound recovery stopped by shutdown` | разбор прерван остановкой (`left`) |

Штатный рестарт в `docker logs api`: `shutdown requested…` → `outbound queue drained` →
`http server closed` → `pg pool closed` → `shutdown complete` (`code: 0`), затем у нового
процесса `server listening`. Тексты оповещений оператора в лог не пишутся — в них имена файлов.

## Конфигурация уровня

`LOG_LEVEL` env-переменная. См. [env.md](env.md).

Чтобы убавить шум — `LOG_LEVEL=info`. Чтобы видеть SQL и события пула — `LOG_LEVEL=trace`.

Уровни pino: `fatal`(60) > `error`(50) > `warn`(40) > `info`(30) > `debug`(20) > `trace`(10).

## Как смотреть логи в docker-compose

```bash
docker compose --profile node logs -f api-node
```

В dev-режиме там pretty-вывод. В prod-сборке (`BUILD_TARGET=production`) — JSON.

**Прод — journald (M30).** На VPS у `api-node` драйвер логов `journald` с тегом `maxtob24-api`
(`docker-compose.server.yml`): лог переживает пересоздание контейнера на деплое, туда же идут
one-off миграции. `docker logs api` и `make prod-logs` показывают только текущий контейнер,
историю — `make prod-journal` на VPS (`sudo journalctl -t maxtob24-api -o cat`, фильтры —
`ARGS="--since '2 hours ago'"`). Это главный источник фактов о неудачах: `message_log` пишет
только успех. Журнал живёт на хосте VPS: после переезда прода история старого хоста на новом не
видна. Подробнее — [vps-prod.md §5](../deploy/vps-prod.md#про-docker-composeserveryml-prod-override).

## См. также

- [Environment](env.md) — `LOG_LEVEL` и прочие env-переменные
- [Webhooks](webhooks.md) — `requestId` в логах обработки вебхуков
- [Architecture](architecture.md) — child-логгеры на модуль (`logger.child({ module })`)
- [Outbound Queue](outbound-queue.md) — логи очереди исходящих, остановки и разбора прерванных
