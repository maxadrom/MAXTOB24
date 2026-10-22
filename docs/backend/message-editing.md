[← Reply / Quoting](reply-quoting.md) · [Назад к README](../../README.md) · [Message Deletion →](message-deletion.md)

# Редактирование сообщений: двусторонний мост правки текста

Коннектор переносит правку текста сообщения в обе стороны. Оба направления —
**отдельные пути** от создания сообщения (`routeInbound`/`routeOutbound`): dedup
по «голому» id нашёл бы запись оригинала и отсёк бы правку как duplicate. Правка
маппится на **тот же external id**, что и оригинал — версионная таблица и миграция
БД не нужны.

| Направление | Триггер | Метод платформы | Маркер «изменено» | Гарантия |
|---|---|---|---|---|
| **MAX → OL** | `message_edited` (тот же `mid`) | `imconnector.update.messages` | `[i]Изменено[/i]` дописываем сами | строгая: ошибка → 500 → MAX ретраит |
| **OL → MAX** | `OnImConnectorMessageUpdate` | `PUT /messages?message_id=…` | MAX сам ставит «Ред.» | ответ 200; сбой → системное сообщение оператору в ОЛ (M28) |

> **Скоуп.** Правка **текста**. Правка медиа — вне MVP (пустой после конвертации
> текст → `skipped: 'empty-edit'`). Идемпотентность — синтетический ключ в
> `message_log`, **без миграции БД**: MAX→OL `edit:<mid>:<ts>` (MAX отдаёт timestamp),
> OL→MAX `edit:<b24MsgId>:<contentToken>` (в `OnImConnectorMessageUpdate` поля
> `message.date` нет — сверено docs MCP 2026-06-17 — токен = хеш текста правки).

---

## MAX → OL: `imconnector.update.messages`

### Поток

```
MAX webhook (message_edited, тот же mid что у оригинала)
  → maxController.handleWebhook        # EDIT_TYPES.has('message_edited') → отдельная ветка
  → maxService.handleIncomingEdit
  → messagingService.routeInboundEdit
      # resolve binding → sender-guard → dedup(edit:<mid>:<ts>)
      # → markupToBbcode + reply-префикс → маркер «Изменено» → b24.updateConnectorMessage → record
  → b24Service.updateConnectorMessage  # обогащает connectorId/lineId, чек SUCCESS
  → b24Client.imconnectorUpdateMessages
```

### Шаги `routeInboundEdit`

1. **resolve binding** — правку в несуществующем/неготовом чате **не** онбордим (оригинала в OL нет → обновлять нечего → `skipped: 'binding-not-ready'`).
2. **sender-guard** — правка без `senderId` не даёт построить автора → `skipped: 'no-sender'` (без 5xx).
3. **dedup** по синтетическому ключу `edit:<mid>:<ts>` (`ts` стабилен при ретраях того же webhook-события). Дубль → `skipped: 'duplicate-edit'`.
   - **оригинал дошёл до OL?** Нет записи `message_log` по «голому» `mid` (сообщение отсеяно как `empty-message`, пришло до привязки, эхо бота) → `skipped: 'no-original'`, Б24 не вызываем (иначе `SUCCESS=false` → 500 → бесполезные ретраи MAX).
4. **пересборка текста с нуля**: `markupToBbcode(text, markup)` (экранирует пользовательские BB-теги — инъекция нейтрализуется) + reply-`>>`-префикс (если есть `replyContext`). Пустой текст → `skipped: 'empty-edit'` (медиа-правка вне скоупа).
5. **маркер правки**: `text + "[br]----[br][i]Изменено[/i]"`. В OL нет авто-маркера правки (в отличие от MAX), поэтому помечаем явно. Пересборка с нуля => маркер **не накапливается** между правками.
6. **build `ConnectorMessage`** на тот же `externalMessageId = max:mid:<mid>`. MAX timestamp в **миллисекундах** → B24 ждёт **секунды** (`Math.floor(ts/1000)`).
7. **update в B24**. Ошибка → record **не** пишем → проброс → 500 → MAX ретраит.
8. **recordInbound** по ключу `edit:<mid>:<ts>` (`INSERT ON CONFLICT DO NOTHING`). Запись оригинала (`maxMid=mid`) **не** трогаем. Гонка вставки → `skipped: 'duplicate-race'` (B24 уже обновлён).

### Эхо-защита

Петли «правка→правка» нет by design: пользователь MAX **не может** редактировать
сообщения бота, а операторская правка приходит обратным каналом
(`OnImConnectorMessageUpdate`), а не как `message_edited`.

---

## OL → MAX: `PUT /messages`

### Поток

```
Б24 событие OnImConnectorMessageUpdate
  → b24Controller.handleWebhook        # event.isMessageUpdate() → отдельная ветка
  → b24Service.handleOpenLineMessageEdit
  → messagingService.routeOutboundQueued('edit') # M29: строка job:edit:… → очередь чата
  → _routeOutboundEditOne              # задание очереди, по сообщению события:
      # resolve binding → maxMid → dedup(edit:<b24MsgId>:<contentToken>)
      # → bbcodeToMarkdown → max.editOutgoing → record → delivery-status
      # сбой → notifyOperator (im.message.add SYSTEM=Y в чат ОЛ)
  → maxService.editOutgoing            # success:false → ошибка; 429 → один повтор
  → maxClient.editMessage              # PUT /messages?message_id=<maxMid> + { text, format }
```

### Шаги `_routeOutboundEditOne`

1. **guard** обязательных полей (`connectorChatId`, `b24MsgId`) → `skipped: 'invalid-message'`.
2. **resolve binding** по `connectorChatId` → `no-binding` / `binding-not-ready`.
3. **maxMid**: id из события (`message.id[]`) и записи оригинала (`findOutbound` по «голому» `b24MsgId`: `payloadMeta.maxMids`, у записей до M22 — `maxMid`), первым — из события. Правится первый (у сообщения из нескольких файлов на нём подпись, M22). Нет → `skipped: 'no-maxmid'` и оповещение «исходное сообщение не найдено» (M28): правка молча не дошла бы — исходное до MAX не доходило или старше журнала. Правка, пришедшая во время заливки файла, ждёт её в очереди чата (M29, [Outbound Queue](outbound-queue.md)) и находит `maxMid` в итоговой записи; «ещё доставляется» остаётся только при переполненной очереди чата (WARN `outbound chat queue full`).
4. **dedup** по `edit:<b24MsgId>:<contentToken>`, где `contentToken = sha256(rawText).slice(0,16)` (хелпер `shared/crypto/contentHash.js`). По доке `OnImConnectorMessageUpdate` per-message `message.date` **отсутствует** (сверено docs MCP 2026-06-17) → `editTs` всегда `null` и как часть ключа непригоден. Хеш текста: разная правка → разный токен (доходит до MAX), тот же текст (ретрай вебхука) → тот же токен (дедупится). Corner-case A→B→A (возврат к прежнему тексту) → коллизия токена, второй возврат ложно дедупится (редко, без падения).
5. **текст** `bbcodeToMarkdown(rawText)`. Маркер на MAX-стороне **не** добавляем (MAX сам ставит «Ред.»). Пустой → `skipped: 'empty-edit'`.
6. **правка в MAX** через `maxService.editOutgoing` (фасад, не `maxClient` напрямую). `PUT /messages` отвечает **200 и на неудачу** — итог в поле `success` (дока MAX; live-проба 2026-10-08):

   | Случай | Ответ MAX |
   |---|---|
   | правка применена | 200 `{"success":true}` — без сообщения, поэтому `timestampMs: null` |
   | сообщение удалено в MAX | 200 `{"success":false,"message":"Error on message edit"}` |
   | несуществующий `mid` правильного формата | 200 `{"success":false,"message":"Invalid chatId: 0"}` |
   | некорректный `mid` | HTTP 400 `{"code":"proto.payload","message":"Invalid message_id: …"}` |
   | текст длиннее 4000 символов | HTTP 400 `{"code":"proto.payload","message":"Field 'text' size (4321) must be at most 4000"}` — live 2026-10-09 |

   Лимит 4000 символов — на весь текст, вместе с подписью оператора `**Имя:**\n`, которую
   Б24 добавляет к сообщению (схема MAX: `NewMessageBody.text` `maxLength: 4000`). Live
   2026-10-09: правка текстом 4300 символов пришла в MAX как 4321 и получила этот отказ;
   точная граница live не снималась. Мост текст не режет — отказ уходит оператору явной причиной (ниже).

   Фасад превращает `success:false` в `MaxApiError` `kind:'rejected'` (текст MAX — в сообщении ошибки), а не в успех: до M28 такая правка писалась в журнал как применённая, и Б24 получал «доставлено». На HTTP 429 — **один** повтор через 1 с (WARN `max outgoing: HTTP 429, retrying once`): MAX разрешает не больше 2 правок в секунду на чат. Таймаут, сеть, `success:false`, 400 и прочие коды — без повтора. Любой `MaxApiError` → записи нет, статуса доставки нет, `skipped: 'edit-failed'` и оповещение оператору (см. [ниже](#недоставка-видна-оператору)). Прочая ошибка (БД, баг) → `edit-error`.
7. **recordOutbound** по ключу `edit:<b24MsgId>:<contentToken>`. Запись оригинала не трогаем. Гонка → `skipped: 'duplicate-race'`.
8. **delivery-status** (best-effort, только после применённой правки): `b24.sendDeliveryStatus` со **всеми** `maxMids` (иначе Б24 забыл бы остальные файлы, и удаление стёрло бы только первый) — дока события `…MessageUpdate` требует вызвать после обработки правки. `date` падает в fallback на timestamp ответа MAX / `Date.now()` (`editTs` всегда `null`, корневой event-`ts` не берём — ретрай-ненадёжен). Ошибка не валит правку.

### Недоставка видна оператору

`routeOutboundEdit` **никогда не бросает наружу**: контроллер отдаёт 200 и на сбой.
Б24 событие не повторяет, а ответ вебхука никто не видит — поэтому о неудавшейся правке
оператор узнаёт системным сообщением в чате ОЛ (M28). Механизм общий с отправкой и
удалением — `notifyOperator` ([Outbound Routing](outbound-routing.md#оповещение-оператора-m28)):
`im.message.add` с `SYSTEM=Y`, клиенту в MAX не уходит, в коннектор не возвращается, Б24
показывает над ним `MAXTOB24` (имя приложения). К правимому сообщению оповещение **не
привязано**: Б24 не сохраняет `REPLY_ID` у системного сообщения (проба 2026-10-08), поэтому
текст общий.

| Исход | Вердикт | Оповещение |
|---|---|---|
| MAX не применил правку: HTTP-ошибка, `success:false`, 429 после повтора | `edit-failed` | `⚠️ Правка не доставлена в MAX: <причина>. У клиентов осталась прежняя версия — отредактируйте сообщение ещё раз.` |
| MAX отверг текст как слишком длинный (400 `proto.payload` `Field 'text' size …`) | `edit-failed` | `⚠️ Правка не доставлена в MAX: текст слишком длинный (4321 символ при лимите MAX 4000). У клиентов осталась прежняя версия — сократите текст и отредактируйте сообщение ещё раз.` |
| таймаут или сеть — исход неизвестен, запрос мог дойти | `edit-failed` | `⚠️ Правка могла не дойти до MAX: <причина>. Если важно, отредактируйте сообщение ещё раз.` |
| сообщения нет в MAX | `no-maxmid` | `⚠️ Правка не доставлена в MAX: исходное сообщение не найдено в MAX (не было доставлено или ещё доставлялось). Отправьте исправленный текст новым сообщением.` |
| внутренняя ошибка моста (БД, баг) | `edit-error` | `⚠️ Правка могла не дойти до MAX: внутренняя ошибка моста. Если важно, отредактируйте сообщение ещё раз.` |

Причина: `MAX не принял (<код MAX>)` или `MAX не принял (HTTP <статус>)` — ошибка HTTP
(400 `proto.payload` даёт `MAX не принял (proto.payload)`); `MAX отказал` — `success:false`;
`MAX не ответил вовремя` / `MAX недоступен` — таймаут / сеть. Исключение — 400
`proto.payload` с сообщением MAX `Field 'text' size (N) must be at most M`: причина
`текст слишком длинный (N символов при лимите MAX M)` — числа из сообщения MAX (`N` — с
подписью оператора), слово «символ» согласуется с `N` (4321 символ, 4002 символа, 4114
символов); без чисел — `текст слишком длинный для MAX`. Разбор — `textTooLongDetails` в
`max/maxApiError.js` по `MaxApiError.maxMessage` (текст ошибки из тела ответа MAX).

- **Без оповещения:** `duplicate-edit`, `invalid-message`, `no-binding`, `binding-not-ready`
  и `empty-edit` (на практике не возникает: Б24 всегда добавляет подпись `[b]Имя:[/b]`).
- **Без дедупа.** Ключ `edit:…` на неудаче не пишется: повтор события — новая попытка, и
  её неудача даёт новое оповещение. Повторная правка оператора доходит.
- **Сбой самого оповещения** вердикт не меняет: у `edit-failed`/`no-maxmid` в нём
  `notified: false` и WARN `notifyOperator: operator notification failed (non-fatal)`; у
  `edit-error` поля `notified` нет, сбой — тот же WARN (или
  `routeOutboundEdit: operator notification on error failed (swallowed)`).
- **Петель нет:** эхо-защита Б24 не триггерит `update` на правку из внешнего канала
  (нашу), а системное сообщение в коннектор не возвращается.
- **Очередь чата (M29).** Правка идёт после отправки и других правок того же чата, ответ Б24
  — после неё. Повтор события, пока правка ещё выполняется, → `duplicate-in-progress`. Правку,
  прерванную рестартом моста, повторить нечем (текста в журнале нет): следующий старт оповещает
  оператора `⚠️ Правка не доставлена в MAX: мост перезапускался. У клиентов осталась прежняя
  версия — отредактируйте сообщение ещё раз.`, если сообщение не удалено ([Outbound Queue](outbound-queue.md#старт-передачи-прерванные-прошлым-процессом)).

---

## Конфигурация и подписка

| Направление | Что включает правку |
|---|---|
| **MAX → OL** | webhook-подписка на `message_edited`. Входит в дефолт `MAX_WEBHOOK_UPDATE_TYPES` (см. [env.md](env.md)); ставится скриптом `register-webhook` (см. [max-webhook-setup.md](max-webhook-setup.md)) |
| **OL → MAX** | привязка события `OnImConnectorMessageUpdate` через `register-events` (M5.1) — скрипт биндит `Add`/`Update`/`Delete` (и `DialogFinish`, M25; `OnAppUninstall`, M26) одним прогоном (см. [connector-registration.md](connector-registration.md)) |

Маркер «Изменено» (`[i]Изменено[/i]`) не настраивается. Отдельных env у фичи нет.

## Ключевые файлы

| Файл | Роль |
|---|---|
| `src/modules/max/maxController.js` | `EDIT_TYPES` (`message_edited`) → `handleIncomingEdit` |
| `src/modules/max/maxService.js` | `handleIncomingEdit`, `editOutgoing` |
| `src/modules/b24/b24Controller.js` | `event.isMessageUpdate()` → `handleOpenLineMessageEdit` |
| `src/modules/b24/b24Service.js` | `handleOpenLineMessageEdit`, `updateConnectorMessage` |
| `src/modules/messaging/messagingService.js` | `routeInboundEdit`, `routeOutboundQueued('edit')` → `_routeOutboundEditOne`, `notifyOperator` |
| `src/modules/messaging/operatorNotices.js` | тексты оповещений оператора (`editFailureNotice`, `deliveryFailureReason`) |
| `src/modules/b24/b24Client.js` | `imconnectorUpdateMessages` (`imconnector.update.messages`) |
| `src/modules/max/maxClient.js` | `editMessage` (`PUT /messages`) |
| `src/modules/max/maxApiError.js` | `kind: 'rejected'` — HTTP 200 с `success:false` |
| `src/modules/b24/models/OpenLineEvent.js` | `isMessageUpdate`, `externalIds`; `editTs` (`message.date`) — в событии нет, всегда `null`, только best-effort вход delivery-status |
| `src/shared/crypto/contentHash.js` | `contentHash(text)` — токен `sha256(text).slice(0,16)` для OUTBOUND edit-ключа |
| `tests/messaging/messagingService.edit.test.js` | unit: `routeInboundEdit` / `routeOutboundEdit`, оповещения |
| `tests/messaging/operatorNotices.test.js`, `tests/messaging/messagingService.notify.test.js` | тексты оповещений, `notifyOperator` |
| `tests/inbound-edit.smoke.test.js`, `tests/outbound-edit.smoke.test.js` | smoke оба направления |
| `tests/max/maxClient.edit.test.js`, `tests/max/maxService.edit.test.js` | `editMessage` / `editOutgoing` |

## Troubleshooting

**Правка из MAX не появилась в OL:**
- `binding-not-ready` — чат ещё не онбордился (правка не онбордит, нужен оригинал).
- `no-original` — оригинал не доходил до OL (нет записи в `message_log` по `mid`).
- `empty-edit` — текст вычистился в пустоту (например медиа-правка — вне скоупа).
- 500 в логах api-node (`routeInboundEdit: B24 call failed`) → MAX ретраит; смотри `b24Code`/`b24Description` (`imconnector.update.messages`).

**Правка оператора (OL) не доехала в MAX** — оператор видит оповещение в чате ОЛ:
- `edit-failed` — ERROR `routeOutboundEdit: MAX edit failed, not recording (operator will be notified)`. Причина — в `reason`, `kind`, `httpStatus`, `maxCode` и `err.message`: там же текст `success:false` от MAX (`Error on message edit` — сообщение удалено в MAX). Записи `edit:…` нет — оператор правит ещё раз.
- WARN `max outgoing: HTTP 429, retrying once` — упёрлись в лимит MAX на правки в чате; второй 429 → `edit-failed`.
- `no-maxmid` — не нашли MAX-сообщение: нет `message.id[]` в событии и нет записи оригинала в `message_log` (не доставлялось или старше журнала). Оповещение «исходное сообщение не найдено». Заливающийся файл правка ждёт в очереди чата; «не найдено» во время заливки — только при переполненной очереди (WARN `outbound chat queue full`).
- `edit-error` — ERROR `routeOutboundEdit: failed (swallowed, returning 200)`: внутренняя ошибка моста (БД, баг). Правка могла и дойти до MAX, оповещение «могла не дойти».
- Оповещения нет — WARN `notifyOperator: operator notification failed (non-fatal)` (`b24Code` — отказ `im.message.add`) или `notifyOperator: no b24ChatId, operator not notified`. Сама неудача правки — в ERROR выше.
- `duplicate-edit` при повторной правке — ключ теперь `edit:<b24MsgId>:<sha256(text)>`; ложно срабатывает лишь на возврате к ровно прежнему тексту (corner-case A→B→A). Раньше баг был структурным: `message.date` в событии нет → `editTs=null` → ключ `edit:<id>:null` стабилен между правками.

## See Also

- [Message Deletion](message-deletion.md) — парный мост удаления (M15), та же схема синтетических ключей
- [Inbound Routing](inbound-routing.md) — `routeInbound` (создание), от которого ответвляется `routeInboundEdit`
- [Outbound Routing](outbound-routing.md) — `routeOutbound` (создание), от которого ответвляется `routeOutboundEdit`
- [Outbound Queue](outbound-queue.md) — очередь исходящих по чату: правка после заливки файла, оповещение о правке, прерванной рестартом
- [Reply / Quoting](reply-quoting.md) — `>>`-цитата и нативный reply, переиспользуемые при пересборке текста правки
