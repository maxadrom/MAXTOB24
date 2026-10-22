[← Connector Registration](connector-registration.md) · [Назад к README](../../README.md) · [Inbound Routing →](inbound-routing.md)

# Backend — Регистрация MAX webhook (M3)

> **Публичный HTTPS обязателен.** На проде мост работает за reverse-proxy с TLS на 443
> (см. [../deploy/vps-prod.md](../deploy/vps-prod.md)); для live-тестов с dev-машины подойдёт
> любой HTTPS-туннель с валидным сертификатом до `api-node`.

Скрипт [scripts/register-webhook.js](../../backends/node/api/scripts/register-webhook.js)
регистрирует подписку MAX Bot API на наш `POST /webhook/max`. После регистрации
MAX доставляет события из `MAX_WEBHOOK_UPDATE_TYPES` (дефолт — [env.md](env.md)):
`message_created`, `message_edited`, `message_removed`, `bot_added`, `bot_removed`,
`user_added`, `user_removed`, `chat_title_changed`.

> Бот общий с продом: `register-webhook` без `--list` запускать только на прод-VPS —
> подписка с dev перехватит прод-вебхук.

## Что делает скрипт

1. **fast-fail валидация:** `MAX_BOT_TOKEN`, `MAX_PUBLIC_WEBHOOK_URL` (HTTPS!),
   `MAX_WEBHOOK_SECRET`, непустой `MAX_WEBHOOK_UPDATE_TYPES`.
2. **default mode (idempotent):** `GET /api/subscriptions` → если URL уже
   подписан, выход 0 без записи. Если `update_types` подписки расходятся с конфигом —
   warn `update_types differ from config` со списками `missing`/`extra`. Иначе
   `POST /api/subscriptions` с `{url, secret, update_types}`.
3. **`--force`:** повторный `POST /api/subscriptions` поверх существующей подписки —
   обновить `update_types` (см. [ниже](#обновить-список-событий---force)).
4. **`--list`:** просто печатает текущие подписки в stdout (JSON), без записи.
5. **`--unregister`:** `DELETE /api/subscriptions?url=<url>` — удаляет подписку.

## Prerequisites

> Прочитайте до запуска.

- Поднят бэкенд `make dev-node` (api-node на `:8000`).
- Публичный HTTPS-доступ к backend работает (dev — HTTPS-туннель, prod — Caddy):
  `curl https://<your-domain>/health` отвечает `200` (публичный health, без auth) —
  значит сервер доступен снаружи, TLS валидный.
- В `.env` заданы:
  - `MAX_BOT_TOKEN` — «Токен доступа» бота на платформе MAX для партнёров
    (Чат-боты → бот → ⋮ → Настройки).
  - `MAX_WEBHOOK_SECRET` — случайная строка 5-256 символов
    (`openssl rand -hex 32`). Допустимы только `[a-zA-Z0-9_-]` (требование
    MAX OpenAPI).
  - `MAX_PUBLIC_WEBHOOK_URL=https://<your-domain>/webhook/max` — HTTPS-URL,
    по которому MAX будет постить. Самоподписанные сертификаты не работают.
- MAX-бот добавлен в подключаемую группу **как админ** (без `is_admin: true`
  и `read_all_messages` в `permissions` бот чужих сообщений не получает).
  Полноценный health-check этого условия — M6, на M3 только warn-лог.

## Quickstart

1. Зарегистрировать webhook:

   ```bash
   make register-webhook
   # ожидаем: "subscription created"
   ```

2. Проверить регистрацию:

   ```bash
   make register-webhook ARGS="--list"
   # ожидаем JSON {subscriptions: [{url: "...", update_types: [...], ...}]}
   ```

3. Отправить тестовое сообщение в группу. В логах api-node:

   ```
   info: max webhook received { updateType: 'message_created',
                                chatId: <MAX_CHAT_ID>,
                                mid: 'mid.ABC...',
                                senderId: 12345 }
   warn: max webhook accepted but inbound routing not yet implemented (M3 → routing in M4)
   ```

   Ответ webhook'а — `202 Accepted` (этого MAX достаточно, доставка засчитана).

4. Переподключить/удалить бота из группы — ожидаем `bot_added`/`bot_removed`
   в логах с `lifecycle: 'bot_added' | 'bot_removed'`.

## Откат

```bash
make register-webhook ARGS="--unregister"
```

Выполняет `DELETE /api/subscriptions?url=...`. Идемпотентно: при повторе MAX
вернёт ошибку «not found», логируется warn и скрипт падает с exit 1 — это
ожидаемо.

## Идемпотентность

Повторный запуск `make register-webhook` без флагов:

- `GET /api/subscriptions` возвращает существующие подписки.
- Если `MAX_PUBLIC_WEBHOOK_URL` уже есть в массиве — лог
  `already subscribed — skipping POST /subscriptions` (или warn о расхождении
  `update_types`), exit 0, `result.alreadySubscribed = true`.
- Иначе — `POST /api/subscriptions`.

## Обновить список событий (`--force`)

Новый тип события в дефолте `MAX_WEBHOOK_UPDATE_TYPES` (например, `chat_title_changed`
в M24 — [Group Title & Icon](group-title-icon.md)) сам в подписку не попадёт: режим по
умолчанию существующую подписку не трогает. Что MAX делает с `update_types` при повторном
`POST /subscriptions` на тот же URL, документация не описывает, поэтому обновление —
только явное и с проверкой. На прод-VPS:

```bash
make register-webhook ARGS="--list"    # текущие update_types
make register-webhook                  # warn: missing [...] — что добавится
make register-webhook ARGS="--force"   # повторный POST с update_types из конфига
make register-webhook ARGS="--list"    # новый тип в update_types, подписка одна
```

Если после `--force` тип не появился или подписок стало две — `--unregister` и
регистрация заново. Между ними события не доставляются: делать в тихое время.

Если в прод-`.env` задан `MAX_WEBHOOK_UPDATE_TYPES`, он перекрывает дефолт — новый тип
нужно добавить туда (и пересоздать контейнер, `.env` читается только при создании).

## Troubleshooting

- **`401 SECRET_MISSING` в логах api-node** — webhook бьёт без заголовка
  `X-Max-Bot-Api-Secret`. Если это сам MAX — значит подписка зарегистрирована
  без `secret`. Перерегистрировать: `--unregister` → проверить `.env` →
  заново `make register-webhook`. Если шум приходит от случайных сканеров,
  это нормально.

- **`401 SECRET_INVALID`** — значение `MAX_WEBHOOK_SECRET` в `.env`
  отличается от того, что было передано в `POST /subscriptions`. Случается
  при ротации секрета без перерегистрации. Решение: `--unregister`,
  обновить `.env`, заново `make register-webhook`.

- **`503 WEBHOOK_NOT_CONFIGURED`** — `MAX_WEBHOOK_SECRET` в `.env` пуст.
  Заполнить и перезапустить api-node (`make down && make dev-node`).

- **`MaxClient POST /subscriptions: HTTP 400` с body про `invalid url`** —
  URL не HTTPS, либо TLS невалиден. Самоподписанные сертификаты MAX
  отвергает. Нужен валидный сертификат (Let's Encrypt OK).

- **`MaxClient ... HTTP 401`** — `MAX_BOT_TOKEN` неверный или отозван.
  Скопировать актуальный (или перевыпустить) на платформе MAX для партнёров:
  Чат-боты → бот → ⋮ → Настройки → «Токен доступа».

- **404 на стороне backend'а** (не secret-401, а реальный 404) — путь `/webhook/max`
  не доходит до api-node. На проде проверить, что Caddy site-блок проксирует
  `handle /webhook/* → 127.0.0.1:5182` (см. [../deploy/vps-prod.md](../deploy/vps-prod.md) §6);
  на dev — что HTTPS-туннель указывает на api-node.

- **Никаких событий из группы при отправке сообщений** — бот не админ либо
  без `read_all_messages`. MAX не доставляет боту чужие сообщения, пока у него
  нет полных админ-прав в группе. В логах увидите при `bot_added`: `bot_added: missing admin permission`.
  Решение: попросить владельца группы выдать боту полные админ-права.

- **MAX перестал доставлять webhook через ~8 часов или 10 неуспешных
  доставок** — MAX автоматически отписывает. На dev это случается, когда
  HTTPS-туннель падал. Решение: заново `make register-webhook`.

## Архитектурные заметки (для AI/новых разработчиков)

- **Подпись MAX webhook — НЕ HMAC.** MAX доставляет `secret` (тот же, что мы
  передали в `POST /subscriptions`) как plain-string в заголовке
  `X-Max-Bot-Api-Secret`. Реализация —
  [shared/http/maxSecretMiddleware.js](../../backends/node/api/src/shared/http/maxSecretMiddleware.js),
  сравнение через `crypto.timingSafeEqual`. Источник истины:
  [официальный OpenAPI MAX schema.yaml:2842](https://github.com/max-messenger/max-bot-api-client-go/blob/main/schemes/schema.yaml#L2842),
  `SubscriptionRequestBody.secret`.
- HMAC-инфраструктура (`shared/crypto/hmac.js`, `buildHmacMiddleware`,
  `verifyRawBody`) остаётся в проекте для других возможных интеграций —
  к MAX она не подключена.
- **Что НЕ делается на M3:** маршрутизация сообщений в Open Lines (M4),
  отправка ответов в MAX (M5), формальный health-check admin-прав с
  user-warning в чат (M6). На M3 контроллер принимает webhook, нормализует
  payload через [MaxUpdate.fromWebhookBody](../../backends/node/api/src/modules/max/models/MaxUpdate.js),
  диспатчит по `update_type`, логирует и отвечает 2xx.
- **Логи webhook'ов на info-уровне НЕ содержат тела сообщений (PII).** Поля:
  `updateType, chatId, mid, senderId`. Полный текст — только на
  `LOG_LEVEL=debug`.

## См. также

- [connector-registration.md](connector-registration.md) — M2, регистрация
  custom-коннектора в Б24 (обязательно сделать ДО `make register-webhook`,
  иначе сообщения некуда отдавать в M4).
- [webhooks.md](webhooks.md) — общий паттерн обработки webhook'ов
  (raw-body, error-handling, идемпотентность).
- [Inbound Routing](inbound-routing.md) — следующий шаг: маршрутизация
  входящих MAX → Open Lines.
