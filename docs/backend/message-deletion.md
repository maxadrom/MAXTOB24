[← Message Editing](message-editing.md) · [Назад к README](../../README.md) · [Outbound Queue →](outbound-queue.md)

# Удаление сообщений: двусторонний мост удаления

Коннектор переносит удаление сообщения в обе стороны. Как и [правка](message-editing.md),
оба направления — **отдельные пути** от создания: dedup по «голому» id нашёл бы
запись оригинала и отсёк бы удаление как duplicate. Удаление маппится на **тот же
external id**, что и оригинал — миграция БД не нужна.

| Направление | Триггер | Метод платформы | Гарантия |
|---|---|---|---|
| **MAX → OL** | `message_removed` (тот же `mid`) | `imconnector.delete.messages` | строгая: ошибка → 500 → MAX ретраит |
| **OL → MAX** | `OnImConnectorMessageDelete` | `DELETE /messages?message_id=…` | ответ 200; не удалилось в MAX → системное сообщение оператору в ОЛ (M28) |

> **Ключ идемпотентности — `delete:<id>` без второй компоненты:** удалить сообщение
> можно лишь раз, версия не нужна (в отличие от правки, где ключ различает версии:
> `edit:<mid>:<ts>` или `edit:<b24MsgId>:<хеш текста>`). Работает и для медиа
> — удаление идёт по внешнему `id`, тип контента не важен. Без миграции БД.

---

## MAX → OL: `imconnector.delete.messages`

### Поток

```
MAX webhook (message_removed, тот же mid что у оригинала)
  → maxController.handleWebhook        # DELETE_TYPES.has('message_removed') → отдельная ветка
  → maxService.handleIncomingDelete
  → messagingService.routeInboundDelete
      # resolve binding → dedup(delete:<mid>) → резолв author + имени → b24.deleteConnectorMessage → record
  → b24Service.deleteConnectorMessage  # обогащает connectorId/lineId, шлём по одному (НЕ batch)
  → b24Client.imconnectorDeleteMessages
```

### Шаги `routeInboundDelete`

1. **resolve binding** — удаление в несуществующем/неготовом чате **не** онбордим → `skipped: 'binding-not-ready'`.
2. **dedup** по синтетическому ключу `delete:<mid>` (без `<ts>`). Дубль → `skipped: 'duplicate-delete'`.
3. **оригинал и его автор**: нет записи `message_log` по «голому» `mid` (оригинал не доходил до OL) → `skipped: 'no-original'`, Б24 не вызываем. `imconnector.delete.messages` ждёт `user.id` = автора оригинала (как при send). `user_id` события — это **кто удалил** (мог быть админ), поэтому тянем `senderId` из записи оригинала (`findInbound(binding, mid).payloadMeta.senderId`); fallback — `senderId` события. Нет ни того, ни другого → `skipped: 'no-author'`.
4. **имя автора** (M23). Б24 переписывает имя пользователя коннектора на **каждом** `imconnector.send/update/delete.messages`. Delete без `user.name` превращает автора в «Гостя» до его следующего сообщения — в журнале диалогов, в чате ОЛ и в автозаголовке нового чата. Дока метода перечисляет в `user` только `id`, но имя Б24 применяет (live-проба 2026-10-07). Поэтому имя берём из `participant_map.max_display_name` по `(binding, автор)` — `bindingsService.findParticipantName`; таблицу пишет `routeInbound` на каждое входящее, там последнее имя. Нет записи → `MAX user <id>`. Имя проходит ту же санитизацию, что на send/update (`b24/connectorUserName.js`, см. [Inbound Routing](inbound-routing.md#имя-автора-в-б24)). `picture` не шлём: его отсутствие аватар не сбрасывает.
5. **delete в B24** по `externalMessageId = max:mid:<mid>` + `user {id, name, last_name: ''}`. Ошибка → record **не** пишем → проброс → 500 → MAX ретраит.
6. **recordInbound** по ключу `delete:<mid>` (`INSERT ON CONFLICT DO NOTHING`). Запись оригинала не трогаем. Гонка → `skipped: 'duplicate-race'`.

### Эхо-защита

Петли «delete→delete» в MAX нет: пользователь **не может** удалять сообщения бота.
Операторское удаление приходит обратным каналом (`OnImConnectorMessageDelete`).

---

## OL → MAX: `DELETE /messages`

### Поток

```
Б24 событие OnImConnectorMessageDelete
  → b24Controller.handleWebhook        # event.isMessageDelete() → отдельная ветка
  → b24Service.handleOpenLineMessageDelete
  → messagingService.routeOutboundQueued('delete') # M29: строка job:delete:<b24MsgId> → очередь чата
  → _routeOutboundDeleteOne            # задание очереди, по сообщению события:
      # resolve binding → maxMid → dedup(delete:<b24MsgId>) → max.deleteOutgoing → record
      # не удалилось (всё или часть) → notifyOperator (im.message.add SYSTEM=Y в чат ОЛ)
  → maxService.deleteOutgoing          # → { deleted, maxMessage }; 429 → один повтор
  → maxClient.deleteMessage            # DELETE /messages?message_id=<maxMid>
```

### Шаги `_routeOutboundDeleteOne`

1. **guard** обязательных полей → `skipped: 'invalid-message'`.
2. **resolve binding** по `connectorChatId` → `no-binding` / `binding-not-ready`.
3. **maxMid'ы** (M22): объединение id из события (`message.id` — строка, нормализуется в `[id]`) и записи оригинала (`payloadMeta.maxMids`, у записей до M22 — `maxMid`). У сообщения из нескольких файлов в MAX по одному сообщению на файл, и сколько id Б24 вернёт в событии, не гарантировано — запись дополняет. Отдельно запоминаются `mid` из записи (по ним считается «удалено не полностью», шаг 5) и время записи оригинала (`created_at`, у записи прерванной передачи — `sentAt`: возраст сообщения для оповещения `max-window`). Нет ни одного `mid` → `skipped: 'no-maxmid'` **без оповещения**: сообщение до MAX не доходило, удалять там нечего. Удаление, пришедшее во время заливки файла, `no-maxmid` не получает: оно ждёт заливку в очереди чата ([ниже](#удаление-и-правка-во-время-заливки-файла--очередь-чата)).
4. **dedup** по `delete:<b24MsgId>`. Дубль → `skipped: 'duplicate-delete'`.
5. **удаление в MAX** через `maxService.deleteOutgoing` — каждого `maxMid` отдельно, сбой одного не мешает остальным. Ответы `DELETE /messages` (дока MAX; live-проба 2026-10-08):

   | Случай | Ответ MAX |
   |---|---|
   | удалено | 200 `{"success":true}` |
   | повтор того же `mid` | снова 200 `{"success":true}` — идемпотентно |
   | несуществующий `mid` правильного формата | 200 `{"success":false,"message":"Invalid chatId: 0"}` |
   | некорректный `mid` | HTTP 400 `{"code":"proto.payload","message":"Invalid message_id: …"}` |

   `success:false` — MAX не удалил, причина в `message`: фасад отдаёт `{ deleted: false, maxMessage }`, координатор пишет её в WARN `routeOutboundDelete: MAX returned success:false for one message`. Лимита удаления по давности в доке MAX нет, и live он не наблюдается: сообщение бота в группе удалилось через 63 ч после отправки (прод, 2026-10-09). Почему MAX может ответить `success:false` на существующее сообщение, неизвестно; вердикт `max-window` — страховка на этот случай. На HTTP 429 — **один** повтор через 1 с (WARN `max outgoing: HTTP 429, retrying once`): MAX разрешает не больше 2 удалений в секунду на чат, а сообщение из нескольких файлов — это несколько `DELETE` подряд. Итог — по таблице [исходов](#исходы-и-оповещения-оператора).
6. **recordOutbound** по ключу `delete:<b24MsgId>` — если удалено хоть одно сообщение MAX (`payload_meta`: `maxMid`, у нескольких файлов ещё `maxMids` и `deletedCount`). Запись оригинала не трогаем. Гонка → `skipped: 'duplicate-race'`. Ничего не удалено → записи нет: повтор события — новая попытка.
7. **delivery-status НЕ шлём** — для удаления он не требуется (в отличие от [правки](message-editing.md)).

### Исходы и оповещения оператора

`routeOutboundDelete` **никогда не бросает наружу**: контроллер отдаёт 200 и на сбой.
Б24 событие не повторяет, а ответ вебхука никто не видит — поэтому о неудавшемся удалении
оператор узнаёт системным сообщением в чате ОЛ (M28). Механизм общий с отправкой и правкой
— `notifyOperator` ([Outbound Routing](outbound-routing.md#оповещение-оператора-m28)):
`im.message.add` с `SYSTEM=Y`, клиенту в MAX не уходит, в коннектор не возвращается.

| Исход | Вердикт, запись | Оповещение |
|---|---|---|
| удалено всё | запись `delete:<id>` | нет |
| часть не удалена (учитываются `mid` из журнала, см. ниже) | запись с `deletedCount` | `⚠️ Удаление доставлено в MAX не полностью: не удалено <n> из <всего> вложений (<причина>). У клиентов в MAX они остались.` |
| ничего не удалено, у учитываемых `mid` сбой MAX (HTTP-ошибка) | `delete-failed`, без записи | `⚠️ Удаление не доставлено в MAX: <причина>. У клиентов в MAX сообщение осталось.` |
| ничего не удалено, у учитываемых `mid` таймаут или сеть — исход неизвестен | `delete-failed`, без записи | `⚠️ Удаление могло не дойти до MAX: <причина>. У клиентов в MAX сообщение могло остаться.` |
| ничего не удалено, MAX ответил `success:false` на все учитываемые `mid` | `max-window`, без записи | `⚠️ Сообщение удалено только в Битрикс24: MAX не разрешил удалить его (отправлено <N> ч назад). У клиентов в MAX оно осталось.` |
| внутренняя ошибка моста (БД, баг) | `delete-error` | `⚠️ Удаление могло не дойти до MAX: внутренняя ошибка моста. У клиентов в MAX сообщение могло остаться.` |

- **Причина** — как у [правки](message-editing.md#недоставка-видна-оператору):
  `MAX не принял (<код MAX>)` / `MAX не принял (HTTP <статус>)`, `MAX не ответил вовремя`,
  `MAX недоступен`. У «не полностью» — причина первой **ошибки** среди учитываемых `mid`
  (`success:false` ошибкой не считается и пропускается): ошибка MAX — по списку выше,
  не-MAX ошибка (баг) — `внутренняя ошибка моста`; если у неудалённых учитываемых `mid`
  только `success:false` — `MAX не разрешил удалить`. Пример: `mid.1` удалён, `mid.2` —
  `success:false`, `mid.3` — HTTP 500 → «не удалено 2 из 3 вложений (MAX не принял
  (HTTP 500))». Смешанный исход «ничего не удалено, часть учитываемых `mid` упала, часть
  `success:false`» → `delete-failed` по первой ошибке среди них.
- **`max-window`** называется так по старому допущению о лимите удаления по давности,
  которое live не подтвердилось (сообщение бота удалилось и через 63 ч). Вердикт остался
  страховкой на `success:false` с неизвестной причиной. Текст оповещения срока не называет:
  возраст сообщения считается по `created_at` записи оригинала — `N ч назад` (от часа),
  `меньше часа назад` или без скобки, если записи нет. У записи, дописанной на старте после
  прерванной передачи (M29, `interrupted: true`), — по `sentAt` (время первой ушедшей
  части): сама запись создана на старте, и после простоя моста её `created_at` занизил бы
  возраст на время простоя.
- **Исход — по журналу.** Как Б24 отдаёт несколько id в событии удаления, live не снято
  (сообщение из нескольких файлов). Поэтому исход и причину решают `mid` из журнала
  (учитываемые), а `mid`, пришедший только в событии, на них не влияет:
  - он не удалился при полностью удалённых `mid` журнала → без оповещения, только WARN
    `routeOutboundDelete: only event-only ids not deleted, message_log ids deleted — not notifying`;
  - ничего не удалено, `mid` журнала ответили только `success:false`, а id из события упал
    (например, склейка, на которую MAX отвечает 400 `proto.payload`) → всё равно `max-window`
    с возрастом сообщения; id из события — в поле `eventOnlyNotDeleted` WARN `max-window` и в
    WARN `routeOutboundDelete: MAX delete failed for one message`.

  Журнал пуст (запись старше M22 или её нет) → учитываются все `mid`.
- **Без оповещения:** `no-maxmid`, `duplicate-delete`, `invalid-message`, `no-binding`,
  `binding-not-ready`.
- **Без дедупа.** Ключ `delete:…` на неудаче не пишется: повтор события — новая попытка, и
  её неудача даёт новое оповещение.
- **Сбой самого оповещения** вердикт не меняет (`notified: false`, WARN
  `notifyOperator: operator notification failed (non-fatal)`).
- **Петель нет:** эхо-защита Б24 не триггерит `delete` на удаление из внешнего канала
  (нашего), а системное сообщение в коннектор не возвращается.

### Удаление и правка во время заливки файла — очередь чата

Пока файл оператора заливается в MAX (секунды, у большого видео — минуты), `maxMid` у
сообщения ещё нет: итоговая запись пишется после всех файлов. До M29 удаление, пришедшее в это
время, получало `no-maxmid` без оповещения, и файл появлялся в MAX уже после удаления в ОЛ.

С M29 отправка, правка и удаление одного чата идут через **очередь чата** строго по одному
([Outbound Queue](outbound-queue.md)). Удаление ждёт конца заливки, находит `maxMids` в
итоговой записи и стирает в MAX все ушедшие части. Ответ Б24 на такое событие приходит после
заливки и удаления. Исключение — очередь чата переполнена (`OUTBOUND_QUEUE_MAX`, WARN
`outbound chat queue full`): задание идёт без ожидания, и `no-maxmid` снова возможен.

Если процесс перезапустился посреди удаления, следующий старт повторит его тем же путём:
повторный `DELETE` уже удалённого `mid` MAX отвечает `success:true`. Прерваны и отправка, и
удаление того же сообщения — ушедшие части дописываются в журнал и удаляются, оповещений нет.

---

## Конфигурация и подписка

| Направление | Что включает удаление |
|---|---|
| **MAX → OL** | webhook-подписка на `message_removed`. Входит в дефолт `MAX_WEBHOOK_UPDATE_TYPES` (см. [env.md](env.md)); ставится `register-webhook` (см. [max-webhook-setup.md](max-webhook-setup.md)) |
| **OL → MAX** | привязка события `OnImConnectorMessageDelete` через `register-events` (M5.1) — биндит `Add`/`Update`/`Delete` (и `DialogFinish`, M25; `OnAppUninstall`, M26) одним прогоном (см. [connector-registration.md](connector-registration.md)) |

Отдельных env у фичи нет.

## Ключевые файлы

| Файл | Роль |
|---|---|
| `src/modules/max/maxController.js` | `DELETE_TYPES` (`message_removed`) → `handleIncomingDelete` |
| `src/modules/max/maxService.js` | `handleIncomingDelete`, `deleteOutgoing` |
| `src/modules/b24/b24Controller.js` | `event.isMessageDelete()` → `handleOpenLineMessageDelete` |
| `src/modules/b24/b24Service.js` | `handleOpenLineMessageDelete`, `deleteConnectorMessage` |
| `src/modules/messaging/messagingService.js` | `routeInboundDelete`, `routeOutboundQueued('delete')` → `_routeOutboundDeleteOne`, `notifyOperator` |
| `src/modules/messaging/operatorNotices.js` | тексты оповещений оператора (`deleteFailureNotice`, `deleteWindowNotice`) |
| `src/modules/b24/b24Client.js` | `imconnectorDeleteMessages` (`imconnector.delete.messages`), `toB24DeleteShape` |
| `src/modules/b24/connectorUserName.js` | санитизация имени автора (send/update/delete) |
| `src/modules/bindings/bindingsService.js` | `findParticipantName` — имя автора для delete из `participant_map` |
| `src/modules/max/maxClient.js` | `deleteMessage` (`DELETE /messages`) |
| `src/modules/b24/models/OpenLineEvent.js` | `isMessageDelete`, `externalIds` (в delete-payload `message.id` — строка → нормализуется в `[id]`) |
| `tests/messaging/messagingService.delete.test.js` | unit: `routeInboundDelete` / `routeOutboundDelete`, оповещения |
| `tests/inbound-delete.smoke.test.js`, `tests/outbound-delete.smoke.test.js` | smoke оба направления |
| `tests/max/maxClient.delete.test.js`, `tests/max/maxService.delete.test.js` | `deleteMessage` / `deleteOutgoing` |

## Troubleshooting

**Удаление из MAX не отразилось в OL:**
- `no-original` — оригинал не доходил до OL (нет записи в `message_log` по `mid`).
- `no-author` — в записи оригинала нет `senderId` и в событии тоже (некого подставить в `user.id`).
- `binding-not-ready` — чат не онбордился.
- 500 в логах (`routeInboundDelete: B24 call failed`) → MAX ретраит; смотри `b24Code`/`b24Description` (`imconnector.delete.messages`).

**Клиент стал «Гостем» после удаления своего сообщения:**
- До M23 delete шёл без `user.name`. Отдельного REST для правки профиля пользователя коннектора нет — такой «Гость» вылечится сам на своём следующем сообщении (send шлёт имя).
- После M23 — смотри debug `routeInboundDelete: author resolved`: `hasName: false` → автора нет в `participant_map`, уйдёт `MAX user <id>` (не «Гость»).

**Удаление оператора (OL) не доехало в MAX** — оператор видит оповещение в чате ОЛ (кроме `no-maxmid`):
- `max-window` — MAX ответил `success:false` на все сообщения. Причина MAX — `maxMessage` в WARN `routeOutboundDelete: MAX returned success:false for one message`, возраст — `ageHours` в WARN `routeOutboundDelete: MAX refused to delete (success:false), not recording (operator will be notified)`. Лимита по давности live не видно (удалено и через 63 ч), так что причину ищите в `maxMessage`; если отказ стабильно приходит только на сообщения старше 63 ч — значит, лимит всё же есть, но длиннее.
- `delete-failed` — ERROR `routeOutboundDelete: MAX delete failed, not recording (operator will be notified)` (`reason`, `kind`); сбой каждого `mid` — WARN `routeOutboundDelete: MAX delete failed for one message` (`kind`, `httpStatus`, `maxCode`).
- «не полностью» — INFO `routeOutboundDelete: delete applied to MAX` с `deletedCount` и `notDeleted`; по каждому неудалённому `mid` — WARN выше.
- WARN `max outgoing: HTTP 429, retrying once` — лимит MAX на удаления в чате; второй 429 → сбой этого `mid`.
- `no-maxmid` — не нашли MAX-сообщение (нет `message.id` в событии и нет записи оригинала). Без оповещения. Заливающийся файл удаление ждёт в очереди чата; `no-maxmid` при живой заливке — только при переполненной очереди (WARN `outbound chat queue full`, см. [выше](#удаление-и-правка-во-время-заливки-файла--очередь-чата)).
- `duplicate-in-progress` — Б24 прислал то же удаление, пока первое ещё выполнялось; удаляет одно ([Outbound Queue](outbound-queue.md)).
- `delete-error` — ERROR `routeOutboundDelete: failed (swallowed, returning 200)`: внутренняя ошибка моста (БД, баг). Удаление могло и дойти до MAX, оповещение «могло не дойти».
- Оповещения нет — WARN `notifyOperator: operator notification failed (non-fatal)` (`b24Code` — отказ `im.message.add`) или `notifyOperator: no b24ChatId, operator not notified`.

## See Also

- [Message Editing](message-editing.md) — парный мост правки текста (M14), та же схема синтетических ключей
- [Inbound Routing](inbound-routing.md) — `routeInbound` (создание), от которого ответвляется `routeInboundDelete`
- [Outbound Routing](outbound-routing.md) — `routeOutbound` (создание), от которого ответвляется `routeOutboundDelete`
- [Outbound Queue](outbound-queue.md) — очередь исходящих по чату, повтор прерванного удаления на старте
- [Deploy: VPS prod](../deploy/vps-prod.md) — боевой запуск моста за Caddy + TLS
