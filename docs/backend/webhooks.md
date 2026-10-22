[← Logging](logging.md) · [Назад к README](../../README.md) · [App Installation →](app-installation.md)

# Backend Webhooks Pattern

В проекте поднимаются два webhook'а: `POST /webhook/max` (MAX Bot API) и
`POST /webhook/b24` (Bitrix24 события). Контракты проверки и кодов ошибок
зафиксированы здесь.

## MAX webhook secret middleware

MAX Bot API доставляет webhook-секрет (тот же, что мы передали в
`POST /subscriptions`) как **plain-string** в HTTP-заголовке
**`X-Max-Bot-Api-Secret`** на каждый запрос. **Никакого HMAC от тела,
никакого timestamp, никакой replay-защиты в протоколе.** Источник истины —
[официальный OpenAPI MAX](https://github.com/max-messenger/max-bot-api-client-go/blob/main/schemes/schema.yaml#L2842),
`SubscriptionRequestBody.secret`: *«A secret to be sent in a header
"X-Max-Bot-Api-Secret" in every webhook request, 5-256 characters»* +
`pattern: ^[a-zA-Z0-9_-]{5,256}$`.

Фабрика middleware: `buildMaxSecretMiddleware(secret, { logger, headerName })`
([shared/http/maxSecretMiddleware.js](../../backends/node/api/src/shared/http/maxSecretMiddleware.js)).
Сравнение — через `crypto.timingSafeEqual` после выравнивания длины буферов.

| Ситуация | Статус | Код | Лог |
|----------|--------|-----|-----|
| `secret` пуст в config | `503` | `WEBHOOK_NOT_CONFIGURED` | `warn` |
| Заголовок отсутствует или пуст | `401` | `SECRET_MISSING` | `warn` |
| Заголовок другой длины | `401` | `SECRET_INVALID` | `warn` (без `timingSafeEqual`, чтобы не бросить) |
| Заголовок не совпал | `401` | `SECRET_INVALID` | `warn` |
| Заголовок совпал | `next()` | — | (после контроллера pino-http) |

**Значение секрета НИКОГДА не пишется в лог.** Unit-тесты этого инварианта —
[tests/shared/http-maxSecretMiddleware.test.js](../../backends/node/api/tests/shared/http-maxSecretMiddleware.test.js).

Имя заголовка по умолчанию — `x-max-bot-api-secret` (Express нормализует
имена в lowercase). Кастомное имя — через `options.headerName`.

Регистрация подписки делается отдельным CLI-скриптом
[scripts/register-webhook.js](../../backends/node/api/scripts/register-webhook.js)
(runbook — [max-webhook-setup.md](max-webhook-setup.md)).

## Сырое тело для HMAC (для других интеграций, к MAX не относится)

Раньше предполагалось, что MAX подписывает webhook'и через HMAC-SHA256 от
сырого тела — это было неверное предположение M1. Подтверждено в M3:
MAX использует plain-secret в заголовке (см. секцию выше).

HMAC-инфраструктура остаётся в проекте для других возможных интеграций
(самописные webhook'и, потенциальный Telegram-bot и т.п.). К `/webhook/max`
она больше **не подключается**.

Решение для сценариев, где raw-body всё-таки нужен — передать `verify`-колбэк
в `express.json()`:

```js
import { verifyRawBody } from './shared/http/rawBody.js';

app.use(express.json({ limit: '256kb', verify: verifyRawBody }));
```

`verifyRawBody(req, _res, buf)` кладёт `buf` в `req.rawBody`. Подключать в
`app.js` **до** монтирования `/webhook/*` роутов.

Фабрика HMAC middleware — `buildHmacMiddleware(secret, { logger, headerName })`
([shared/http/hmacMiddleware.js](../../backends/node/api/src/shared/http/hmacMiddleware.js)).
Контракт аналогичный maxSecretMiddleware, но проверяет
`verifyHmacSha256(secret, req.rawBody, signature)` с `timingSafeEqual`.
Коды ошибок: `WEBHOOK_NOT_CONFIGURED` / `HMAC_MISSING` / `HMAC_INVALID`.

## Application token для Б24

Б24 шлёт события Open Lines (`OnImConnectorMessageAdd`, а также
`OnImConnectorMessageUpdate` / `OnImConnectorMessageDelete` — правка/удаление
оператора, и `OnImConnectorDialogFinish` — закрытие диалога, M25) и `ONAPPUNINSTALL` —
удаление приложения (M26) с полем `auth[application_token]`. Конверт auth общий;
`b24Controller` расходит маршрут по типу события (`isAppUninstall()` →
`b24Service.handleAppUninstall`, [App Installation](app-installation.md#удаление-и-переустановка-m26);
`isDialogFinish()` → `routeDialogFinish`, [Group Session Opener](group-session-opener.md);
`isMessageUpdate()` / `isMessageDelete()` → best-effort outbound-edit/delete). Сравниваем токен с сохранённым
`installations.b24_application_token` той же инсталляции:

```js
const expected = (await installations.getCurrent()).b24ApplicationToken; // > env B24_APPLICATION_TOKEN
if (!timingSafeStrEqual(event.applicationToken, expected)) return 401;  // B24_AUTH_INVALID
```

Токен в БД пишет install-callback (`POST /api/install`, см.
[app-installation.md](app-installation.md)). Нет ни токена в БД, ни env-fallback
`B24_APPLICATION_TOKEN` → `503 B24_WEBHOOK_DISABLED`.

**Гейт удалённого приложения (M26).** После `ONAPPUNINSTALL` строка `installations` помечена
`uninstalled_at`, токены обнулены. Тогда **любое** событие получает
`503 B24_APP_UNINSTALLED` ещё до проверки токена: env-fallback `B24_APPLICATION_TOKEN` вебхук
снова не откроет, это делает только переустановка (`POST /api/install` снимает пометку).
Раскрытие то же, что у `B24_WEBHOOK_DISABLED`; оба `503` — осознанные исключения из правила
«5xx — только ошибки БД и баги».

После токена сверяется `auth.member_id` с сохранённым `installations.b24_member_id`:
другой → `401 B24_MEMBER_MISMATCH`. Пока `b24_member_id` пуст (его заполняет
install-callback или OAuth-рефреш), сверка пропускается; событие без `member_id` —
warn `auth.member_id absent` и пропуск.

## Ответы и идемпотентность

| Статус | Когда | Что делает MAX |
|--------|-------|----------------|
| `200 { ok: true, ... }` | обработано полностью | засчитывает доставку |
| `200 { ok: true, status: 'ignored' }` | update принят, но не поддержан/не маршрутизирован | засчитывает доставку |
| `4xx` (НЕ secret-проверка) | клиентская ошибка (невалидный JSON) — возвращает errorHandler | НЕ ретраит |
| `401` от secret-middleware | secret не пришёл / не совпал | НЕ ретраит (это уровень транспорта) |
| `5xx` (кроме `503 WEBHOOK_NOT_CONFIGURED`) | серверная ошибка | **ретраит до 10× за 8 часов**, потом отписывает |

**Никаких 5xx из `maxController` на корректно подписанные webhook'и.** Все
неподдерживаемые `update_type` отвечают `200 { status: 'ignored' }`, чтобы
MAX не ретраил.

Исключение — приложение Б24 удалено (`ONAPPUNINSTALL`, M26): входящее из новой группы
получает `503 CONFIG_ERROR` (привязка не создаётся), из старой (`CLEAN=0`) — `502 B24_NO_AUTH`.
Это намеренно: MAX ретраит, и после переустановки в пределах окна ретраев сообщение дойдёт
([App Installation](app-installation.md#удаление-и-переустановка-m26)).

**`/webhook/b24` отвечает после доставки.** Б24 событие не повторяет, поэтому исходящие
(отправка, правка, удаление OL → MAX) обрабатываются синхронно: ответ уходит, когда сообщение
доставлено в MAX или оператор оповещён о неудаче. С M29 событие встаёт в очередь своего чата и
ждёт исходящие этого чата, принятые раньше: ответ на текст, пришедший, пока мост заливает файл в MAX,
придёт после файла (`responseTime` в access-логе — секунды и десятки секунд). События других
чатов не ждут. Обрыв соединения со стороны Б24 или прокси обработку не прерывает. При остановке
процесса (`SIGTERM`) порт остаётся открытым, пока очередь не опустеет и не ответят запросы в
работе: события, пришедшие во время деплоя, обрабатываются, а не получают 502 (кроме окна ~1 с
между выходом старого процесса и стартом нового). Подробности — [Outbound Queue](outbound-queue.md).

Идемпотентность строго в `messagingService`, через `messageLogRepository`
(по `body.mid` для входящих, по `im.message_id` для исходящих). Адаптеры
(`max/`, `b24/`) её **не** обеспечивают.

Все маршруты координатора идут через один каркас `_once`: поиск ключа в `message_log` →
эффект во внешней системе → запись (`INSERT … ON CONFLICT DO NOTHING`). Найденный ключ →
`skipped` с `logId` (WARN), пустой INSERT (конкурентный ретрай уже записал факт) →
`duplicate-race` (INFO). Ошибка эффекта пробрасывается **без записи** → 500 → отправитель
ретраит; ERROR-лог сбоя `imconnector.*` пишет только координатор (`b24Code`, `b24Description`).

`_once` не защищает от двух **одновременных** одинаковых событий: до конца эффекта ключа в
журнале нет, и оба прошли бы поиск. Для исходящих это закрывает строка задания (M29): до
постановки в очередь координатор пишет `job:<ключ операции>` со `status='in_progress'` через тот
же уникальный индекс, второй такой INSERT пуст → `duplicate-in-progress`, строка снимается по
завершении задания ([Outbound Queue](outbound-queue.md#строки-заданий-в-message_log)).

**Правка и удаление — синтетические ключи dedup.** `message_edited`/`message_removed`
(MAX→OL) и `OnImConnectorMessageUpdate`/`OnImConnectorMessageDelete` (OL→MAX)
приходят с тем же `id`, что и оригинал, поэтому dedup по «голому» id отсёк бы их как
duplicate. Координатор использует синтетические ключи правки (`edit:<mid>:<ts>` для
MAX→OL; `edit:<b24MsgId>:<хеш текста>` для OL→MAX, т.к. `OnImConnectorMessageUpdate` не
несёт `message.date`) и удаления (`delete:<id>`) в `message_log` — **без миграции БД**.
Детали — [Message Editing](message-editing.md) /
[Message Deletion](message-deletion.md).

Ещё синтетические ключи inbound: lifecycle (`<event>:<chatId>:<userId>:<ts>`,
[Membership Notifications](group-membership-notifications.md)), интро группы
(`group-intro:<chatId>`), переименование группы (`chat_title_changed:<chatId>:<ts>`) и
ссылка на группу (`group-link:<chatId>:<хеш ссылки>`, M27: та же ссылка — один раз,
перевыпущенная — новым ключом) — [Group Title & Icon](group-title-icon.md); опенер сессии
(`group-session:<chatId>:<закрытая сессия>:<mid>`, при неизвестном номере сессии — `0`) —
[Group Session Opener](group-session-opener.md).
`OnImConnectorDialogFinish` в `message_log` не пишется: внешнего эффекта нет, флаг на
привязке ставит идемпотентный UPDATE с guard'ами в SQL. `ONAPPUNINSTALL` (M26) — тоже:
сброс токенов идемпотентен, а повтор отсекает гейт `503 B24_APP_UNINSTALLED`.

## Периметр: реальный IP и rate-limit

С M20 `req.ip` — реальный адрес клиента, а лимиты считаются per-IP.

**Цепочка на проде.** Caddy (host-network, TLS) → `127.0.0.1:5182` → docker-proxy → контейнер
`api-node`. Контейнер видит адресом сокета шлюз docker-сети (`172.19.0.1`), а не loopback.
Caddy перезаписывает `X-Forwarded-For` реальным адресом клиента: входящие `X-Forwarded-*` от
недоверенных клиентов он игнорирует, пока в Caddyfile нет `trusted_proxies`.

**`TRUST_PROXY`** (default `loopback, uniquelocal`) говорит express, каким адресам верить
`X-Forwarded-For`. Шлюз docker-сети лежит в `172.16.0.0/12` (`uniquelocal`), поэтому XFF от
docker-proxy принимается, а `req.ip` берётся из него. Если порт опубликован напрямую (базовый
`docker-compose.yml`, `8000:8000`), DNAT сохраняет публичный адрес клиента — он не доверен, и
подделанный XFF игнорируется. Значения `true` и `*` запрещены: с ними клиент подставил бы любой IP.
Если docker-сеть вне `172.16/12` (свой `default-address-pools`), задайте её подсеть явно, напр.
`TRUST_PROXY=loopback, 100.64.0.0/10`.

**Лимитеры** (`shared/http/rateLimit.js`), у каждого свой счётчик:

| Маршрут | Ключ | Порядок | Зачем так |
|---|---|---|---|
| `POST /webhook/max` | IP | секрет → лимитер → контроллер | неверный секрет — дешёвый 401 без БД, квоту не тратит |
| `POST /webhook/b24` | IP | лимитер → контроллер (токен) | проверка `application_token` требует SELECT `installations`; мусор с чужого IP тратит только свой бакет |
| `POST /api/install` | общий | лимитер → контроллер | каждый запрос может уйти обменом `refresh_token` на OAuth-сервер; per-IP открыл бы поток `invalid_grant` с многих адресов |

Превышение — `429 RATE_LIMITED` и `warn [FIX][ratelimit]` с `ip`, `remoteAddress`, `limiter`.
Ответы несут заголовки `RateLimit-*` (draft-6). Б24 событие не повторяет, поэтому 429 на
настоящем `/webhook/b24` означает потерянное сообщение оператора — лимиты щадящие намеренно.

**Проверка на проде.** В access-логе у `POST /webhook/*` поле `req.ip` — публичные адреса
MAX/Б24, `req.remoteAddress` — шлюз docker-сети. Запрос
`curl -s -D- -o/dev/null -X POST -H 'X-Forwarded-For: 1.2.3.4' https://<домен>/webhook/b24`
пишет в лог ваш IP, а не `1.2.3.4`.

## Логирование

- Access-лог `pino-http` на каждый запрос: `req.{id,method,url,ip,remoteAddress}` и
  `res.statusCode` (см. [logging.md](logging.md)).
- `info` на каждый принятый webhook: `{ updateType, chatId, mid, senderId,
  requestId }`. Тело сообщения (`body.text`, `attachments`) в `info` **не
  пишется** — только на `LOG_LEVEL=debug`.
- `warn` на secret-mismatch (без значения секрета), `unhandled update_type`,
  `NotImplementedError` от routing.
- Структурный логгер — `pino`, `requestId` привязывается через
  `pino-http` на уровне `app.js`.

## См. также

- [max-webhook-setup.md](max-webhook-setup.md) — runbook регистрации MAX
  webhook'а (M3).
- [connector-registration.md](connector-registration.md) — регистрация
  custom-коннектора в Б24 (M2).
- [logging.md](logging.md) — общие правила структурного логирования.
- [outbound-queue.md](outbound-queue.md) — очередь исходящих по чату, ответ `/webhook/b24`
  после доставки, остановка с дренажом (M29).
