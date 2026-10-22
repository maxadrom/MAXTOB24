[← App Installation](app-installation.md) · [Назад к README](../../README.md) · [MAX Webhook Setup →](max-webhook-setup.md)

# Backend — Регистрация коннектора MAX в Bitrix24 (M2)

> **Публичный HTTPS обязателен.** На проде мост работает за reverse-proxy с TLS на 443
> (см. [../deploy/vps-prod.md](../deploy/vps-prod.md)); для live-тестов с dev-машины подойдёт
> любой HTTPS-туннель с валидным сертификатом до `api-node`.

Скрипт [scripts/register-connector.js](../../backends/node/api/scripts/register-connector.js)
выполняет одноразовую регистрацию custom-коннектора в портале Б24 и активирует
его на заданной Open Line.

## Что делает скрипт

1. **fast-fail валидация:** наличие installation с непустым `b24_access_token`,
   корректные `B24_PORTAL`, `OL_LINE_ID`, `B24_PLACEMENT_HANDLER_URL`.
2. `imconnector.list` — idempotency-проверка (не зарегистрирован ли уже
   коннектор с тем же `B24_CONNECTOR_ID`).
3. `imconnector.register` (только если ещё не зарегистрирован) — payload:
   - `ID=<B24_CONNECTOR_ID>` (по умолчанию `max_b24`)
   - `NAME=<B24_CONNECTOR_NAME>` (по умолчанию `Макс для групп`)
   - `CHAT_GROUP=1`, `NEED_SIGNATURE=1` — группировка авторов в одной сессии OL
   - `ICON=<SVG-stub>` (см. [b24Constants.js](../../backends/node/api/src/modules/b24/b24Constants.js))
   - `PLACEMENT_HANDLER=<B24_PLACEMENT_HANDLER_URL>`
4. `imconnector.activate` на `LINE=<OL_LINE_ID>`.
5. Опционально — `GET /me` MAX API → `max_bot_id`. Если `MAX_BOT_TOKEN` не задан
   или вызов упал — продолжаем без него.
6. `installationsService.seedSingleTenant(...)` — записывает `connector_id`,
   `ol_line_id`, `max_bot_id` в существующую installation. Токены
   (`b24_access_token`/`refresh`/`application_token`) **не затираются**
   (COALESCE в `updateConnectorMetadata`).

## Prerequisites

> Прочитайте до запуска. Скрипт не подменяет install-flow.

- На портале `$B24_PORTAL` **уже установлено приложение** (local или cloud). После
  установки `POST /api/install` записывает в `installations`: `b24_portal` + токены
  (см. [app-installation.md](app-installation.md)). Без этой записи скрипт fast-fail'ит.
- **Авторизация — только через OAuth-токен приложения.** Inbound webhook
  портала (Битрикс24 → Разработчикам → Другое → Входящий вебхук) для
  `imconnector.*` **не подходит**: B24 даёт `WRONG_AUTH_TYPE` /
  `Application context required`. Все `imconnector.*` требуют application context.
- **Права (scope) приложения** — задаются в форме локального приложения в Б24 (сверено с
  apidocs.bitrix24.ru, 2026-10-22):

  | Scope | Зачем мосту |
  |---|---|
  | `imopenlines` | методы `imconnector.*` (регистрация, отправка, правка, удаление, статус доставки, название чата) и `imopenlines.dialog.get` |
  | `imconnector` | события `OnImConnectorMessageAdd/Update/Delete`, `OnImConnectorDialogFinish` |
  | `im` | `im.message.add` (системные сообщения оператору) и `im.dialog.messages.search` (нативный reply OL → MAX) |

  Для одной регистрации коннектора хватает `imopenlines`, но без остальных мост не получит
  ответы оператора и не сможет писать системные сообщения.
- **`B24_PLACEMENT_HANDLER_URL`** — публично доступный HTTPS-URL, по которому
  Б24 откроет «настройки коннектора» в слайдере. На M2 UI не делаем —
  эндпоинт-заглушка регистрируется автоматически: `GET /b24/connector-settings`
  возвращает минимальный HTML. На dev URL обычно выглядит как
  `https://<your-domain>/b24/connector-settings`.
- Файл с большой буквы или маленькой — в проекте `makefile` (`m` маленькая).
  Любые make-команды работают с ним же.

## Quickstart

1. Убедиться, что приложение установлено:

   ```bash
   psql "$DATABASE_URL" -c "SELECT b24_portal, b24_access_token IS NOT NULL AS has_token FROM installations"
   ```

   Должна быть строка с `has_token = t`. Если нет — пересохраните форму приложения на
   портале: Б24 пришлёт `ONAPPINSTALL` на `POST /api/install` (см. [app-installation.md](app-installation.md)).

2. Прописать `.env`:

   ```env
   B24_PORTAL=example.bitrix24.ru
   OL_LINE_ID=42
   B24_CONNECTOR_ID=max_b24
   B24_CONNECTOR_NAME=Макс для групп
   B24_PLACEMENT_HANDLER_URL=https://<your-domain>/b24/connector-settings
   ```

3. Опционально — `MAX_BOT_TOKEN`, чтобы скрипт записал `max_bot_id` через
   `GET /me` MAX API.

4. Запуск:
   - В docker-окружении: `make register-connector`
   - С хоста (требует прокинутую `DATABASE_URL`):
     `pnpm run register-connector` из `backends/node/api/`

## Откат

```bash
make register-connector ARGS="--unregister"
```

Выполняет `imconnector.activate({ACTIVE: '0'})` + `imconnector.unregister` +
`installationsService.clearConnectorMetadata()` (`ol_line_id`/`connector_id`/`max_bot_id` →
NULL). Токены **не трогаем**. Если коннектор не был зарегистрирован, обе
B24-операции в try/catch с `warn`-логом — скрипт не падает.

## Идемпотентность

Повторный запуск без `--unregister` — пропускает `imconnector.register`
(проверка по `Object.keys(imconnector.list())`) и просто выполняет
`imconnector.activate` (он сам по себе идемпотентен — повторная активация
с `ACTIVE=1` no-op'ная). В логах увидите `wasAlreadyRegistered: true`.

### Флаг `--update` (форс-обновление иконки/имени)

```bash
make register-connector ARGS="--update"
# или: pnpm run register-connector -- --update
```

`--update` форсирует повторный `imconnector.register` (обновляет иконку/имя,
даже если коннектор уже зарегистрирован) + `imconnector.activate`, **без** шага
`seedSingleTenant`. На проде это безопасно: не перетирает `max_bot_id` и прочие
metadata инсталляции — меняется только презентация коннектора в Контакт-центре.

## Troubleshooting

- **`B24ApiError B24_NO_AUTH`** — нет installation, либо `b24_access_token`
  пустой. Пересохраните форму приложения на портале (install-callback).

- **`B24ApiError B24_expired_token`** — токен протух (срок жизни ~1 час), и
  auto-refresh не сработал. `b24Client` сам обновляет пару access/refresh через
  `oauth.bitrix.info`, только если заданы `B24_CLIENT_ID`/`B24_CLIENT_SECRET` —
  проверьте их. Если refresh-токен тоже недействителен — пересохраните форму
  приложения на портале (install-callback) и перезапустите `make register-connector`.

- **`B24ApiError B24_WRONG_AUTH_TYPE`** (`Application context required`) —
  запрос идёт под inbound webhook'ом portal'а, а не под OAuth-токеном
  приложения. Все `imconnector.*` требуют application context. Убедитесь,
  что `installations.b24_access_token` непустой и приложение реально
  установлено.

- **`B24ApiError B24_insufficient_scope`** — приложение установлено, но
  не имеет scope `imopenlines`. Проверьте манифест приложения и переустановите.

- **`B24ApiError B24_NO_PLACEMENT_HANDLER`** — не задан
  `B24_PLACEMENT_HANDLER_URL` или URL недоступен снаружи. Проверьте
  публичный HTTPS (домен/туннель): `curl -I $B24_PLACEMENT_HANDLER_URL` должен вернуть 200.

- **`B24ApiError B24_CONNECTOR_ID_REQUIRED`** — передан пустой
  `B24_CONNECTOR_ID`. Default `max_b24` должен сработать; проверьте,
  не перезаписан ли env пустой строкой.

- **`B24ApiError B24_APPLICATION_REGISTRATION_ERROR_POINT`** — в
  `B24_CONNECTOR_ID` есть символ `.`. Используйте только `[a-z0-9_]`.

- **`B24ApiError B24_ERROR_ARGUMENT: Argument 'LINE' is null or empty`** —
  не задан `OL_LINE_ID` либо передан как строка с пробелом.

- **`ERROR_METHOD_NOT_FOUND imconnector.send.messages`** (всплывёт уже в M4) —
  метод имеет другое имя на текущем тарифе/конфигурации портала. Попробуйте
  `imconnector.send` или поищите свежие имена в b24-dev-mcp. Зафиксируйте
  правильное имя в `b24Client.imconnectorSendMessages`.

## Грабли B24, зафиксированные в коде

- `imconnector.register` и `imconnector.unregister` используют поле **`ID`**.
  `imconnector.activate`/`list`/`connector.data.set`/`send.*`/`status` — поле
  **`CONNECTOR`**. (verified против MCP-доки 2026-05-26).
- `imconnector.list` параметров не принимает; возвращает **объект**
  `{connector_id: connector_name}`, не массив. `b24Service.registerConnector`
  использует `Object.keys()` для idempotency-проверки.
- Точка `.` в `ID` запрещена (`APPLICATION_REGISTRATION_ERROR_POINT`).
- `ICON` — обязательная структура `{DATA_IMAGE, COLOR, SIZE, POSITION}`. На M2
  используется SVG data-URI заглушка. Реальная брендированная картинка —
  пост-MVP.

## Связь с другими milestone

После M2 коннектор существует и активирован на OL 42, но **сообщений не ходит**:

- M3 — MAX webhook на `POST /webhook/max` с `X-Max-Bot-Api-Secret`. После
  `make register-connector` обязательно зарегистрировать подписку MAX →
  см. **[max-webhook-setup.md](max-webhook-setup.md)** (runbook M3).
- M4 — Inbound (MAX → OL) через `imconnector.send.messages`. На M2 — каркас
  метода в `b24Client`, реальной отправки нет.
- M5 — Outbound (OL → MAX) через `OnImConnectorMessageAdd`.

## См. также

- [docs/backend/env.md](env.md) — список переменных окружения.
- [docs/backend/architecture.md](architecture.md) — общая архитектура.
- [docs/backend/max-webhook-setup.md](max-webhook-setup.md) — следующий шаг
  после регистрации коннектора: подписка MAX webhook (M3).
- [docs/backend/webhooks.md](webhooks.md) — общий паттерн webhook'ов
  (secret/HMAC middleware, идемпотентность).
