[← Group Session Opener](group-session-opener.md) · [Назад к README](../../README.md) · [Message Editing →](message-editing.md)

# Reply / цитирование: двусторонний мост «ответ на сообщение»

Коннектор переносит связь «ответ на сообщение» в обе стороны, но **разными механизмами** — потому что транспорты несимметричны:

| Направление | Что видит получатель | Механизм | Стоимость |
|---|---|---|---|
| **MAX → OL** | визуальная цитата `>>` в начале текста OL-сообщения | BB-префикс в тексте (без БД, без REST) | бесплатно, всегда включено |
| **OL → MAX** | нативный кликабельный reply в MAX | `link:{ type:'reply', mid }` + добор `REPLY_ID` | +1 REST/исходящее, отключаемо |

`imconnector.send.messages` **не имеет поля reply**, поэтому inbound-связь нельзя перенести нативно — её эмулируем цитатой. В обратную сторону MAX Bot API reply поддерживает, но событие `OnImConnectorMessageAdd` **не несёт `REPLY_ID`**, поэтому связь приходится добирать листингом сообщений чата.

> **BB-коды (verified docs MCP 2026-06-10, «Форматирование текста»):** в чатах/ОЛ Б24 тега `[quote]` **нет** — он рендерится литерально. Цитата строки — префикс `>>текст` в начале строки (серый цитат-блок). Markdown не поддерживается.

---

## MAX → OL: визуальная цитата `>>`

### Поток

```
MAX webhook (message_created с message.link)
  → MaxUpdate.fromWebhookBody → parseReplyContext(message.link)
      → replyContext = { type, parentMid, parentText, parentSenderName }
  → messagingService.routeInbound
      → markupToBbcode(text, markup)
      → buildReplyQuoteBbcode(replyContext, { maxLen })   // BB-префикс ">>…\n"
      → text = quotePrefix + text                          // ДО empty-message-guard
      → b24Service.sendConnectorMessage (imconnector.send.messages)
```

### Формат цитаты

| `replyContext.type` | Результирующий префикс |
|---|---|
| `reply` | `>><Имя>: <текст>\n` |
| `reply` (родитель-медиа без текста) | `>><Имя>\n` |
| `forward` | `>>↪ Переслано (<Имя>): <текст>\n` (помеченная цитата, не reply) |
| нет ни имени, ни текста | `''` — префикс не добавляется |

- **Имя родителя** (`deriveParentSenderName`) — `sender.name` → `first_name last_name` → `null`. В отличие от `deriveSenderName`, **без** хвостового fallback `MAX user <id>`: для цитаты нужно реальное имя, иначе цитируем без имени.
- **Текст родителя** (`sanitizeQuoteText`) — `\s+` схлопывается в один пробел (цитата `>>` — одна строка, любой `\n` внутри прервал бы её), обрезка по `maxLen` с многоточием `…`.
- **Префикс добавляется ДО empty-message-guard.** Reply-на-медиа с пустым `body.text` и без файлов иначе отсеялся бы как empty — а цитата делает текст непустым, и сообщение доходит.

### Парсинг `message.link`

`parseReplyContext` (в `MaxUpdate.js`) принимает только `type ∈ {reply, forward}`. Нет `link` / неизвестный type / битая форма → `null` (не падаем; `routeInbound` шлёт без цитаты). `parentText=''` допустим — цитируем только имя.

---

## OL → MAX: нативный reply

### Поток

```
Б24 событие OnImConnectorMessageAdd (БЕЗ REPLY_ID)
  → messagingService.routeOutbound  (только text-path; media-reply вне MVP)
      └─ if config.reply.resolveOutbound:
         → b24Service.resolveReplyContext({ b24ChatId, b24MsgId, limit })   // best-effort, никогда не бросает
             → b24Client.imDialogMessagesSearch (im.dialog.messages.search, ORDER {ID:DESC}, LIMIT)
             → { replyId, parentConnectorMid, forward } | null
         → messagingService._resolveReplyMaxMid({ binding, replyContext })  // сырьё → MAX mid
             → { maxMid, resolvedVia }
         → replyLink = { type:'reply', mid: maxMid }   // если maxMid добыт
      → maxClient.sendMessage(MaxMessage{ …, link: replyLink })   // body.link
```

### Добор `REPLY_ID` (`resolveReplyContext`)

Событие не несёт связь — добираем листингом последних сообщений чата:

1. `im.dialog.messages.search` (scope `im`, `ORDER {ID:DESC}`, `LIMIT` из config) — свежие сообщения у вершины окна.
2. Найти **Y** (само исходящее): `String(m.id) === String(b24MsgId)` (событие даёт строку, search — число).
3. `replyId = Y.params.REPLY_ID`; нет → `null` (обычное сообщение, не reply).
4. Найти родителя **P** (`id === replyId`) среди `messages ∪ additionalMessages`, прочитать `params.CONNECTOR_MID` (массив → `[0]`).

Возвращает `{ replyId, parentConnectorMid, forward }` либо `null`. **Best-effort — никогда не бросает:** reply косметика, мост важнее.

### Маппинг в MAX-mid (`_resolveReplyMaxMid`)

`b24Service` даёт **сырые** `REPLY_ID`/`CONNECTOR_MID`; маппинг в MAX-mid (с доступом к `message_log`/binding) делает **координатор** — граница `b24/` ↔ `messaging/` остаётся чистой.

| `resolvedVia` | Условие | MAX mid |
|---|---|---|
| `connector-mid-client` | `CONNECTOR_MID = "max:mid:<mid>"` (родитель — клиентское) | strip префикса `max:mid:` |
| `connector-mid-operator` | `CONNECTOR_MID = "<maxMid>"` (родитель — операторское, уже доставлено) | как есть |
| `none` (служебное / без mid) | `CONNECTOR_MID = "max:…"`, но не `max:mid:` — интро группы (`max:group-intro:<chatId>`, [Group Title & Icon](group-title-icon.md)), опенер сессии (`max:group-session:…`, [Group Session Opener](group-session-opener.md)) и входящее без mid (`max:nomid:…`, [Inbound Routing](inbound-routing.md#сообщение-без-mid-m21)) | mid родителя в MAX неизвестен → шлём без reply |
| `message-log` | fallback: `findOutbound(binding, REPLY_ID).payloadMeta.maxMid` | из журнала |
| `none` | mid не добыт ни одним путём | → шлём без reply |

> Optional chaining в fallback **обязателен**: `findOutbound` возвращает `null`, когда строки нет (`MessageLogEntry.fromRow → null`) — иначе `entry.payloadMeta.maxMid` бросил бы на `null`.

### Best-effort и стоимость

- Любая ошибка / `null` на любом шаге → сообщение уходит **без** `link` (мост не падает).
- `resolveOutbound` стоит **+1 REST на каждое исходящее** (`im.dialog.messages.search`). Отключается `B24_REPLY_RESOLVE_OUTBOUND=false`.
- `im.dialog.messages.search` **нельзя в batch** (`ERROR_BATCH_METHOD_NOT_ALLOWED`).
- В `MessagingService` без проводки `reply` (CLI/тесты) дефолт безопасный — `resolveOutbound:false`, чтобы отсутствие config случайно не включило добор.

---

## Конфигурация

Все три env опциональны, с дефолтами; доступны через `config.reply`. Полная таблица — в [env.md](env.md#reply-флоу-двусторонний-мост-ответ).

| Переменная | Default | Назначение |
|---|---|---|
| `B24_REPLY_RESOLVE_OUTBOUND` | `true` | Звать ли `im.dialog.messages.search` (добор нативного reply OL→MAX) |
| `REPLY_SEARCH_LIMIT` | `50` | `LIMIT` окна листинга; clamp ≤ `200` (доковый предел) |
| `REPLY_QUOTE_MAX_LEN` | `200` | Макс. длина текста родителя в `>>`-цитате MAX→OL |

`B24_REPLY_RESOLVE_OUTBOUND` принимает `1/0`, `true/false`, `yes/no`, `y/n`, `on/off` (регистронезависимо); неизвестное → дефолт. `REPLY_SEARCH_LIMIT` непарсится/≤0 → ошибка старта; больше `200` молча зажимается.

## Целевой метод B24

`im.dialog.messages.search` (scope `im`, сверено через docs MCP 2026-06-10):

| Параметр | Значение |
|---|---|
| `CHAT_ID` | числовой `b24ChatId` (binding) |
| `ORDER` | `{ ID: 'DESC' }` — свежие сообщения у вершины окна |
| `LIMIT` | из `config.reply.searchLimit` (clamp ≤ 200) |
| `LAST_ID` | для пагинации (резерв, в MVP не используется) |

`SEARCH_MESSAGE` **не** шлём — нужен листинг, а не текстовый поиск (снято live). Связь несут `params.REPLY_ID` и `params.CONNECTOR_MID` элементов ответа.

## Ключевые файлы

| Файл | Роль |
|---|---|
| `src/modules/max/models/MaxUpdate.js` | `parseReplyContext`, `deriveParentSenderName` → `replyContext` |
| `src/modules/b24/bbcode.js` | `buildReplyQuoteBbcode`, `sanitizeQuoteText` (MAX→OL) |
| `src/modules/messaging/messagingService.js` | `routeInbound` (quote-префикс), `routeOutbound` (добор reply), `_resolveReplyMaxMid` |
| `src/modules/b24/b24Service.js` | `resolveReplyContext` (best-effort) |
| `src/modules/b24/b24Client.js` | `imDialogMessagesSearch` (`im.dialog.messages.search`) |
| `src/modules/max/models/MaxMessage.js` | поле `link` (`{ type:'reply', mid }`, mid обязателен) |
| `src/modules/max/maxClient.js` | `sendMessage` → `body.link` |
| `src/shared/config/index.js`, `schema.js` | `buildReplyConfig`, env-резолверы, `DEFAULTS` |
| `tests/messaging/messagingService.test.js` | routeInbound quote + routeOutbound reply + `_resolveReplyMaxMid` |
| `tests/b24/b24Service.test.js`, `tests/b24/b24Client.test.js` | `resolveReplyContext` / `imDialogMessagesSearch` |
| `tests/b24/bbcode.test.js` | `buildReplyQuoteBbcode` |
| `tests/max/MaxUpdate.test.js`, `tests/max/maxClient.upload.test.js` | `replyContext` / `link` в `sendMessage` |
| `tests/shared/config.test.js` | резолв `config.reply` |

## Troubleshooting

**Цитата `>>` не появляется в OL:**
- В webhook нет `message.link` либо его `type` не `reply`/`forward` → `replyContext = null` (обычное сообщение).
- У родителя не оказалось ни имени, ни текста → префикс не добавляется (by design).

**Цитата `>>` рендерится литерально (виден сам `>>`):**
- Это нормально для **начала строки**. Если `>>` оказался не в начале (например, после `\n` внутри текста) — Б24 не сделает цитат-блок. `sanitizeQuoteText` именно поэтому схлопывает переносы.

**Reply OL→MAX не кликабельный / не проставился:**
1. DEBUG `routeOutbound: reply resolved` с `replyMidPresent:false` → mid родителя не добыт (`resolvedVia:none`): родителя нет в окне `REPLY_SEARCH_LIMIT`, либо `message_log` не содержит строки. Увеличьте `REPLY_SEARCH_LIMIT` (≤200).
2. `B24_REPLY_RESOLVE_OUTBOUND=false` → добор отключён, reply не проставляется вовсе (ожидаемо).
3. WARN `resolveReplyContext: failed` → сбой `im.dialog.messages.search` (scope `im`, доступ к чату) — сообщение всё равно ушло, но без reply.

**Лишние REST-запросы / латентность исходящих:**
- `resolveOutbound:true` добавляет один `im.dialog.messages.search` на каждое исходящее. Если нативный reply не нужен — выключите `B24_REPLY_RESOLVE_OUTBOUND=false`.

## See Also

- [Inbound Routing](inbound-routing.md) — `routeInbound` MAX → Open Lines, куда встраивается `>>`-цитата
- [Outbound Routing](outbound-routing.md) — `routeOutbound` Open Lines → MAX, куда встраивается добор reply
- [Formatting + Delivery](formatting-delivery.md) — BB↔markdown конвертация, BB-коды Б24
- [Environment](env.md) — `B24_REPLY_RESOLVE_OUTBOUND`, `REPLY_SEARCH_LIMIT`, `REPLY_QUOTE_MAX_LEN`
