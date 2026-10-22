[← Outbound Routing](outbound-routing.md) · [Назад к README](../../README.md) · [Admin Health-check →](admin-healthcheck.md)

# Backend — Форматирование текста + delivery-статус

Runbook эксплуатации двустороннего форматирования (BB↔markdown) и подтверждения
доставки (`imconnector.send.status.delivery`) — реализовано поверх outbound-моста M5.2.

Цепочка outbound с форматированием и delivery (всё внутри [backends/node/api/](../../backends/node/api/)):

```
POST /webhook/b24  (auth[application_token])
  → b24Controller.handleWebhook
  → b24Service.handleOpenLineMessageAdd
  → messagingService.routeOutbound
      resolve binding → dedup → bbcodeToMarkdown → MAX send (format:markdown)
      → record → sendDeliveryStatus (best-effort, try/catch)
  → maxClient.sendMessage   # POST /messages?chat_id + { text, format:'markdown' }
  → b24Client.imconnectorSendStatusDelivery  # imconnector.send.status.delivery
```

Цепочка inbound (MAX → OL):

```
POST /webhook/max
  → maxController.handleUpdate
  → messagingService.routeInbound
      markupToBbcode(body.text, body.markup) → ConnectorMessage → imconnector.send.messages
```

## Контракт `imconnector.send.status.delivery`

| Поле | Тип | Описание |
|---|---|---|
| `CONNECTOR` | string | `connectorId` из `installations` (не из event) |
| `LINE` | integer | `olLineId` из `installations` |
| `MESSAGES[].im.chat_id` | string | `im.chat_id` из события Б24 |
| `MESSAGES[].im.message_id` | string | `im.message_id` из события Б24 |
| `MESSAGES[].message.id` | array | массив внешних id (`[maxMid]`) |
| `MESSAGES[].message.date` | integer | Unix-timestamp в **секундах** доставки |
| `MESSAGES[].chat.id` | string | `connectorChatId` (`max:<MAX_CHAT_ID>`) |

Ответ: `{ SUCCESS: bool, DATA: [], time }` (не `DATA.RESULT[]` как у `send.messages`).

⚠️ Поля `STATUS` **нет** — само обращение фиксирует факт доставки.
⚠️ Auth: **Application context** обязателен (access_token из installations).

## BB↔markdown: правила конвертации

### Outbound (OL → MAX): `bbcodeToMarkdown`

| Входной BB-фрагмент | Результат (markdown) |
|---|---|
| `[b]Жирный[/b]` или `[B]…[/B]` | `**Жирный**` |
| `[i]Курсив[/i]` или `[I]…[/I]` | `_Курсив_` |
| `[br]` / `[br/]` | `\n` (перенос строки) |
| `[u]Подчёркнутый[/u]` | `Подчёркнутый` (тег вырезан) |
| `[url=http://x]ссылка[/url]` | `ссылка` (тег вырезан) |
| `[USER=123]Имя[/USER]` | `Имя` (тег вырезан) |
| любой прочий BB-тег | вырезается |
| `null`/не-строка | `''` |

Результат `trim()`'ится. Пустой текст → `skipped:'empty-message'`.

Реализация: [b24/bbcode.js](../../backends/node/api/src/modules/b24/bbcode.js) — `bbcodeToMarkdown`.
MAX получает body `{ text, format: 'markdown' }` (const `MAX_OUTBOUND_FORMAT = 'markdown'` в
[messagingService.js:13](../../backends/node/api/src/modules/messaging/messagingService.js#L13)).

### Inbound (MAX → OL): `markupToBbcode`

MAX передаёт форматирование НЕ как маркеры в `body.text`, а как массив аннотаций `body.markup[]`:

| `body.markup[].type` | Пример `body.markup` | Результат (BB) |
|---|---|---|
| `strong` | `{from:0, length:6, type:'strong'}` | `[b]…[/b]` |
| `emphasized` | `{from:9, length:6, type:'emphasized'}` | `[i]…[/i]` |
| неизвестный type | `{from:0, length:5, type:'underline'}` | текст без изменений |
| `markup` отсутствует или `[]` | — | pass-through (текст as-is) |
| `null`/не-строка в `body.text` | — | `''` |

`body.text` всегда содержит **plain-текст** без маркеров; форматирование — только в `body.markup[]`.

Реализация: [b24/bbcode.js](../../backends/node/api/src/modules/b24/bbcode.js) — `markupToBbcode(text, markup)`,
вызывается в [messagingService.js:169](../../backends/node/api/src/modules/messaging/messagingService.js#L169).

**Статус inbound (подтверждено live-проверкой):** форматирование MAX→OL работает.
Проверено: «Жирный и Курсив» из MAX с `body.markup:[{from:0,length:6,type:'strong'},{from:9,length:6,type:'emphasized'}]`
→ `[b]Жирный[/b] и [i]Курсив[/i]` в B24 OL (жирный и курсив отображаются корректно).

**Ограничение платформы MAX (inbound):** входящие сообщения из MAX **не имеют** статуса
доставки/прочтения на стороне MAX Bot API — нет endpoint для отметки `read`/`delivered`
для inbound-сообщений. `imconnector.send.status.delivery` работает только для исходящих (OL→MAX).

## Outbound literal-маркеры (MVP-риск)

Под `format:'markdown'` в MAX: плоский текст оператора с literal `*`/`_`/`**`
(математика `2 * 2`, имена файлов `my_file.txt`, пути `C:\dir`) может
**исказиться** — ложный курсив/жирный/потеря символов. Для MVP — принятый риск,
задокументированный здесь. При необходимости решение: слать `format` только когда
исходный BB-текст реально содержал `[b]`/`[i]` (иначе опустить поле).

## Delivery-статус — best-effort

Вызов `imconnectorSendStatusDelivery` происходит **после** `recordOutbound` (сообщение
уже в MAX и в `message_log`). Обёрнут в `try/catch`:
- провал → `log.warn` с `b24Code`, **без проброса** исключения;
- вердикт `ok:true` уже записан выше до `try`;
- Б24 **не** получает ретрай-триггер из-за провала галочки.

Если `maxMid` отсутствует (MAX ответил без `body.mid`) — delivery-вызов пропускается
с `warn 'routeOutbound: no maxMid from MAX, skipping delivery status'`.

## Ручная проверка acceptance (M5.3)

**Предварительно:** пересобрать контейнер с актуальным кодом:
```bash
docker compose --profile node up -d --build api-node
```

Затем поднять мониторинг логов:
```bash
make logs  # или docker compose --profile node logs -f api-node
```

1. В OL 42 ответить оператором с **жирным** и _курсивом_ (кнопки форматирования OL).
2. В MAX-группе `<MAX_CHAT_ID>` ожидать: `**Имя:**\n**Жирный** _курсив_` — без сырых `[b]`.
3. В OL у исходящего сообщения должна появиться **галочка «доставлено»**.
4. В логах — цепочка (без `WARN delivery status failed`):

```
DEBUG routeOutbound: bb-converted text   textPrefix: '**Имя:**\n...'
DEBUG maxClient.sendMessage: start       format: 'markdown'
INFO  maxClient: ok                      status: 200
INFO  routeOutbound: delivered to MAX    maxMid: mid.xxx
DEBUG b24.sendDeliveryStatus: calling…   b24MsgId, connectorId, lineId
INFO  b24.callMethod: ok                 method: imconnector.send.status.delivery
INFO  b24.sendDeliveryStatus: ok         b24MsgId, connectorChatId
DEBUG routeOutbound: delivery status sent
```

### Live acceptance

Текст OL → MAX:
```
[b]Имя Фамилия:[/b] [br]Текст [b]Жирный[/b] [i]Курсив[/i] и [u]Подчеркнутый[/u]
→ **Имя Фамилия:**\nТекст **Жирный** _Курсив_ и Подчеркнутый
```
`[u]` срезан (не в scope M5.3).
Delivery: первый вызов → `expired_token` → auto-refresh → `ok: true` → галочка «доставлено» ✅.

## Troubleshooting

| Симптом | Причина | Действие |
|---|---|---|
| `WARN routeOutbound: delivery status failed` + `b24Code: expired_token` | access_token протух, auto-refresh не помог | Пересохранить форму приложения в Б24 (ONAPPINSTALL обновит токены, см. [app-installation.md](app-installation.md)) |
| `WARN routeOutbound: delivery status failed` + `b24Code: WRONG_AUTH_TYPE` | Нет Application context — неправильный токен | Проверить, что `b24_access_token` в `installations` — токен приложения, не пользователя |
| `WARN routeOutbound: delivery status failed` + `b24Code: IMCONNECTOR_NO_CORRECT_PROVIDER` | `connectorId` неверный или коннектор не зарегистрирован | Проверить `connector_id` в таблице `installations`; перезапустить `make register-connector`. |
| Галочки «доставлено» нет, в логах нет WARN | `maxMid` не пришёл в ответе MAX | MAX ответил без `body.mid`; проверить body MAX-ответа в DEBUG-логах |
| MAX получает текст с сырыми BB-кодами (`[b]...[/b]`) | Контейнер работает на старом коде | Пересобрать: `docker compose --profile node up -d --build api-node` |
| `MaxClient POST /messages: HTTP 4xx` на `format:'markdown'` | MAX API не поддерживает поле `format` с этим значением | Проверить актуальный контракт MAX Bot API; временно убрать `format` из `MaxMessage` |
| Форматирование не отображается в OL (inbound) | MAX прислал `body.markup` с неизвестным `type` | `markupToBbcode` игнорирует неизвестные типы — поддержаны только `strong`/`emphasized` |

## Scope: что поддержано / что нет

| Поддержано (M5.3) | Не поддержано (post-MVP) |
|---|---|
| `[b]`↔`**` (жирный) | `[u]` подчёркнутый |
| `[i]`↔`_` (курсив) | `[url=…]` ссылки |
| `[br]`→`\n` перенос | `[USER=…]` упоминания |
| Delivery-статус «доставлено» в OL | `imconnector.send.status.reading` (галочка «прочитано») |
| Inbound: `body.markup` → BB (`strong`↔`[b]`, `emphasized`↔`[i]`) | Богатое форматирование (списки, цитаты, код, эмодзи) |
| | Медиа-вложения |

## Автотесты

```bash
cd backends/node/api

# Конвертеры + roundtrip
pnpm exec vitest run tests/b24/bbcode.test.js

# Delivery-клиент + сервис
pnpm exec vitest run tests/b24/b24Client.test.js tests/b24/b24Service.test.js

# routeOutbound/routeInbound + smoke
pnpm exec vitest run tests/messaging/messagingService.test.js \
  tests/outbound.smoke.test.js tests/inbound.smoke.test.js
```

## См. также

- [Outbound Routing](outbound-routing.md) — M5.2: outbound-мост (предшественник).
- [Inbound Routing](inbound-routing.md) — M4.2: inbound MAX → Open Lines.
- [reply-quoting.md](reply-quoting.md) — двусторонний мост «ответ»: `>>`-цитата и нативный reply.
