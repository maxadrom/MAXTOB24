[← Inbound Routing](inbound-routing.md) · [Назад к README](../../README.md) · [Formatting + Delivery →](formatting-delivery.md)

# Backend — Outbound routing Open Lines → MAX

> **Публичный HTTPS обязателен.** На проде мост работает за reverse-proxy с TLS на 443
> (см. [../deploy/vps-prod.md](../deploy/vps-prod.md)); для live-тестов с dev-машины подойдёт
> любой HTTPS-туннель с валидным сертификатом до `api-node`.

Runbook эксплуатации и ручной проверки outbound-маршрутизации: ответ оператора
из сессии Open Lines (`OL_LINE_ID`) доезжает до группового чата MAX со штатной подписью
(BB-коды убраны). Реализован на контрактах, верифицированных в M5.1.

Цепочка кода (всё внутри [backends/node/api/](../../backends/node/api/)):

```
POST /webhook/b24  (auth[application_token])
  → b24Controller.handleWebhook         # OpenLineEvent.fromWebhookBody, redacted-лог, scoped-логгер
  → b24Service.handleOpenLineMessageAdd # info-лог, проброс { logger }
  → messagingService.routeOutboundQueued('add')  # M29: isMessageAdd → normalizedMessages → по сообщению:
                                        #   resolve binding → claim job:<im.message_id> → очередь чата
  → _routeOutboundOne                   # задание очереди (прежний маршрут routeOutbound):
                                        #   dedup → bbcodeToPlainText → MAX send → record
                                        #   сбой → notifyOperator (системное сообщение в чат ОЛ)
  → maxService.sendOutgoingMessage      # фасад разбирает ответ MAX → { maxMid, timestampMs }
  → maxClient.sendMessage               # POST /messages?chat_id=<maxChatId> + {text} via _fetchJson
```

Идемпотентность исходящих — по `im.message_id` Б24 через `message_log`
(partial-unique индекс на `(binding_id, direction, b24_msg_id)`). Dedup живёт
в координаторе **до** вызова MAX; при ошибке MAX `recordOutbound` **не** пишется.

**Очередь чата (M29).** Отправка, правка и удаление одного чата выполняются строго по одному:
правка и удаление, пришедшие, пока мост заливает файл в MAX, ждут его. Разные чаты — параллельно.
Порядок держится только для событий, уже пришедших в мост: Б24 присылает событие о файле, лишь когда оператор полностью загрузил его в Битрикс24, поэтому текст, отправленный во время такой загрузки, приходит в MAX раньше файла — это порядок Б24 (live 2026-10-09).
На время задания в `message_log` лежит строка `job:<ключ операции>` со `status='in_progress'`:
повтор того же события, пока первое выполняется, получает `duplicate-in-progress`, а
передачу, прерванную рестартом, следующий старт показывает оператору. Ответ Б24 — по-прежнему
после доставки, у события, вставшего за файлом, — после файла. Поток, лимит очереди,
остановка с дренажом и восстановление — [Outbound Queue](outbound-queue.md).

> **Б24 событие не повторяет** («Повторных отправок нет» — дока событий Б24; M22).
> Поэтому недоставка в MAX — не 500, а ответ 200 с вердиктом `delivery-failed`
> (или `failedFiles` у сообщения с файлами) и **системное сообщение оператору** в чате
> ОЛ: `⚠️ Не доставлено в MAX: текст сообщения — MAX не принял (chat.denied). Отправьте
> ещё раз.` 500 остаётся только для ошибок БД и багов — о них оператор тоже получает
> best-effort оповещение «могло не дойти» (M28). Сбой правки и удаления виден оператору
> так же (M28) — см. [Оповещение оператора](#оповещение-оператора-m28). Дедуп по-прежнему
> защищает от повтора, если событие всё же придёт дважды.

## Scope (что делает / чего НЕ делает M5.2)

| Поддержано | Не поддержано (post-MVP) |
|---|---|
| `OnImConnectorMessageAdd` с текстом | CRM-привязка сессии к Company |
| `OnImConnectorMessageUpdate` → правка в MAX ([Message Editing](message-editing.md)) | Multi-tenant |
| `OnImConnectorMessageDelete` → удаление в MAX ([Message Deletion](message-deletion.md)) | Медиа-**правка** (правка вложения) — вне MVP |
| BB-код подписи → plain-text (`[b]/[br]` → strip/newline) | |
| Медиа-вложения OL → MAX (upload-флоу) — [Media Transfer](media-transfer.md) | |
| Dedup по `im.message_id` (у файлов — `file:<im.message_id>:<n>`), повтор безопасен; на время задания — строка `job:<ключ операции>` со `status='in_progress'` (M29) | |
| Очередь исходящих по чату, дренаж при остановке, оповещение о передаче, прерванной рестартом (M29) — [Outbound Queue](outbound-queue.md) | |
| Недоставка → системное сообщение оператору в ОЛ (M22); сбой правки/удаления и внутренняя ошибка — тоже (M28) | |
| Scoped-логгер с `requestId` до `routeOutbound` | |
| `application_token` не утекает в лог (redacted) | |

> **Правка/удаление — отдельные пути.** `b24Controller` диспатчит `OnImConnectorMessageUpdate`
> в маршрут правки и `OnImConnectorMessageDelete` в маршрут удаления — с M29 через ту же
> очередь чата (`routeOutboundQueued('edit' | 'delete')`). Оба не валят вебхук, а сбой
> показывают оператору (M28). Привязка этих событий — `register-events` (M5.1),
> биндит `Add`/`Update`/`Delete`, `OnImConnectorDialogFinish` (M25,
> [Group Session Opener](group-session-opener.md)) и `OnAppUninstall` (M26,
> [App Installation](app-installation.md#удаление-и-переустановка-m26)) одним прогоном. Детали — [Message Editing](message-editing.md) / [Message Deletion](message-deletion.md).

## Prerequisites

1. M5.1 выполнен: событие `OnImConnectorMessageAdd` привязано к `/webhook/b24`
   (`make register-events`). Проверить: `make register-events ARGS="--list"`.
2. На портале `$B24_PORTAL` **установлено приложение** — `installations` содержит
   непустой `b24_application_token` (пишет `ONAPPINSTALL`; появился в M5.1).
3. Коннектор зарегистрирован и активирован на `$OL_LINE_ID`, seed binding выполнен
   (см. [Inbound Routing](inbound-routing.md) — те же prerequisites).
4. `MAX_BOT_TOKEN` в `.env` непустой — `maxClient._fetchJson` бросает без токена.
5. `B24_EVENT_HANDLER_URL` — публичный HTTPS-URL для event handler
   (prod-домен или dev-туннель): `https://<your-domain>/webhook/b24`.

## Env-переменные (outbound-блок)

| Env | Назначение | Обязательна |
|---|---|---|
| `B24_EVENT_HANDLER_URL` | URL приёмника событий Б24 | да |
| `MAX_BOT_TOKEN` | токен MAX-бота для `POST /messages` | да |
| `B24_APPLICATION_TOKEN` | env-fallback проверки `/webhook/b24`, пока в БД нет токена; после удаления приложения (M26) не действует | нет (берётся из ONAPPINSTALL) |

Полная таблица env — [env.md](env.md).

## Последовательность развёртывания

```bash
# Только если M5.1 ещё не выполнен (событие не привязано):
make register-events

# Деплой кода M5.2:
make dev-node         # или docker compose --profile node up -d --force-recreate api-node
                      # (restart НЕ перечитывает env_file — грабли M4.2)

# Проверить токены:
docker compose exec api env | grep -E 'MAX_BOT_TOKEN|B24_APPLICATION_TOKEN'
```

> **Если `b24_access_token` протух** (~1ч TTL): переоткрыть локальное приложение
> в интерфейсе Б24 — это сбросит токен. При этом `b24_application_token` не
> затрагивается (он пишется при первой установке через `ONAPPINSTALL`).

## Ручная проверка acceptance

1. Поднять стек: `make dev-node`, дождаться `INFO server listening  port: 8000`.
2. Включить `LOG_LEVEL=debug` в `.env` (или передать как env при старте).
3. В Б24 открыть **Контакт-центр → Открытые линии → линия 42**, найти сессию,
   написать ответ оператора.
4. В логах backend (`make logs`) ожидаем цепочку с одним `requestId`:

   ```
   DEBUG b24 webhook raw payload          rawBody: { ..., auth: '[redacted]' }
   INFO  b24 webhook received             event: ONIMCONNECTORMESSAGEADD, lineId: '42'
   INFO  b24 open line message add       event: ..., lineId: '42'
   DEBUG routeOutbound: resolve binding   connectorChatId: max:<MAX_CHAT_ID>
   DEBUG messageLog.claimOutboundJob      bindingId, jobKey: job:<b24MsgId>      (M29)
   DEBUG routeOutbound: resolve binding   (повторно — уже в задании очереди)
   DEBUG routeOutbound: dedup check       bindingId, b24MsgId
   DEBUG routeOutbound: bb-stripped text  textPrefix: '...' (без BB-кодов)
   DEBUG routeOutbound: sending to MAX    chatId: <MAX_CHAT_ID>
   DEBUG maxClient.sendMessage: start     chatId, textPrefix
   INFO  maxClient: ok                    method: POST, path: /messages
   INFO  messageLog.recordOutbound        bindingId, b24MsgId
   INFO  routeOutbound: delivered to MAX  b24MsgId, maxMid, durationMs
   INFO  outbound job done                op: add, verdict: ok, queuedMs, durationMs, bypass: false
   DEBUG messageLog.releaseOutboundJob    id
   ```

5. Сообщение пришло в MAX-группу `<MAX_CHAT_ID>` с **подписью без BB-кодов**:
   `Имя Фамилия:\nТекст ответа` (не `[b]Имя:[/b] [br]Текст`).
6. В БД появилась запись:

   ```bash
   docker compose exec -T database-postgres psql -U appuser -d appdb \
     -c "SELECT id, binding_id, direction, b24_msg_id, payload_meta->>'maxMid' AS max_mid
         FROM message_log WHERE direction='outbound' ORDER BY id DESC LIMIT 3;"
   ```

> ⚠️ `application_token` в лог не пишется (`auth:'[redacted]'`). Текст сообщения
> — только префикс ≤32 символов на уровне `debug`.

## Дубль-проверка (идемпотентность)

Повтор того же `im.message_id` (ручной curl или повтор события) **не** шлёт второго
сообщения в MAX и **не** создаёт второй строки в `message_log`:

```bash
# Ручной реплей с тем же message_id (заменить APP_TOKEN и MESSAGE_ID):
curl -X POST http://localhost:8000/webhook/b24 \
  --data-urlencode "event=ONIMCONNECTORMESSAGEADD" \
  --data-urlencode "auth[application_token]=<APP_TOKEN>" \
  --data-urlencode "auth[domain]=example.bitrix24.ru" \
  --data-urlencode "data[CONNECTOR]=max_b24" \
  --data-urlencode "data[LINE]=42" \
  --data-urlencode "data[MESSAGES][0][im][message_id]=<MESSAGE_ID>" \
  --data-urlencode "data[MESSAGES][0][im][chat_id]=<B24_CHAT_ID>" \
  --data-urlencode "data[MESSAGES][0][message][user_id]=1" \
  --data-urlencode "data[MESSAGES][0][message][text]=тест" \
  --data-urlencode "data[MESSAGES][0][chat][id]=max:<MAX_CHAT_ID>"
```

Ожидаемый ответ на дубль: `{"ok":true,"result":{"ok":true,"results":[{"skipped":"duplicate","logId":...}]}}`.
В `message_log` по этому `b24_msg_id` по-прежнему **одна** строка. MAX не зван.

Дубль, пришедший, **пока первое событие ещё выполняется** (например, файл заливается),
отсекает строка задания `job:<MESSAGE_ID>`: ответ
`{"ok":true,"result":{"ok":true,"results":[{"skipped":"duplicate-in-progress"}]}}`, WARN
`routeOutbound: duplicate-in-progress, skipping`. После завершения строки `job:` нет — в
журнале только запись сообщения (M29, [Outbound Queue](outbound-queue.md)).

Автотест этого пути — [tests/outbound.smoke.test.js](../../backends/node/api/tests/outbound.smoke.test.js)
(DB-gated: при отсутствии Postgres — skip, не fail).

## BB-код → plain-text (поведение конвертера)

Конвертер [b24/bbcode.js](../../backends/node/api/src/modules/b24/bbcode.js):

| Входной фрагмент | Результат |
|---|---|
| `[b]Имя:[/b] [br]текст` | `Имя:\nтекст` |
| `[br/]` (самозакрывающийся) | `\n` |
| `[url=http://x]ссылка[/url]` | `ссылка` |
| неизвестный тег | вырезается |
| `null`/`undefined`/не-строка | `''` |

Результат всегда `trim()`'ится. Пустой текст после strip → `skipped:'empty-message'`
(MAX не дёргается).

## Skip-вердикты `routeOutbound`

Все вердикты → контроллер **200 OK**. Ошибка БД или баг → 5xx (recordOutbound при
этом не пишется); Б24 такое событие не повторит, поэтому оператору уходит best-effort
оповещение `⚠️ Сообщение могло не дойти до MAX: внутренняя ошибка моста. Проверьте и при
необходимости отправьте ещё раз.` (M28): сообщение могло и уйти в MAX — упасть могла,
например, только запись в журнал. Если упала БД, оповещение, скорее всего, тоже не уйдёт
(токен портала читается из БД) — тогда только лог. Наружу летит исходная ошибка, а не ошибка
оповещения. С M29 ошибка одного сообщения не обрывает остальные сообщения события: они уже в
очереди чата и выполнятся, а ответ всё равно 500. Если БД упала на claim строки задания, в MAX
ничего не ушло: остальные сообщения события не ставятся, ответ 500, оповещение то же.

| Вердикт | Причина |
|---|---|
| `ignored-event` | Событие не `OnImConnectorMessageAdd` (другой тип) |
| `no-messages` | `data.MESSAGES` пуст или отсутствует |
| `invalid-message` | Сообщение без `chat.id` или `im.message_id` |
| `no-binding` | Нет binding для `connectorChatId` из события |
| `binding-not-ready` | Binding есть, но без `connectorChatId` |
| `duplicate` | Тот же `im.message_id` уже записан в `message_log` |
| `duplicate-in-progress` | То же событие ещё выполняется: строка `job:<ключ операции>` уже есть (M29). Также у правки и удаления |
| `empty-message` | Текст пуст после BB-strip |
| `duplicate-race` | `recordOutbound` вернул null (concurrent insert) |
| `delivery-failed` | MAX не принял текст / ни один файл не ушёл (M22). Записи нет, оператору — системное сообщение |

Частичный успех (часть файлов не ушла) — не skip: `{ ok: true, maxMids, failedFiles }`
и системное сообщение со списком недоставленных файлов. Подробности —
[Media Transfer](media-transfer.md).

**Правка и удаление** (`routeOutboundEdit` / `routeOutboundDelete`) отвечают 200 всегда —
внутренняя ошибка там тоже даёт вердикт, а не 500. Вердикты с оповещением оператора (M28):

| Вердикт | Причина |
|---|---|
| `edit-failed` | MAX не применил правку (HTTP-ошибка, `success:false`, таймаут, сеть). Записи нет |
| `no-maxmid` (правка) | Сообщения нет в MAX — правка молча не дошла бы |
| `edit-error` | Внутренняя ошибка правки (БД, баг) — «могла не дойти» |
| `delete-failed` | Ни одно сообщение MAX не удалено, у `mid` из журнала — сбой MAX. Записи нет |
| `max-window` | Ни одно не удалено, MAX ответил `success:false` на все `mid` из журнала (id только из события на исход не влияют). Записи нет |
| `delete-error` | Внутренняя ошибка удаления (БД, баг) — «могло не дойти» |

Удаление не полностью (часть файлов осталась в MAX) — не skip: запись и оповещение.
Без оповещения: `no-maxmid` у удаления, `duplicate-edit` / `duplicate-delete`,
`duplicate-in-progress`, `empty-edit`, `invalid-message`, `no-binding`, `binding-not-ready`. Тексты и логи —
[Message Editing](message-editing.md#недоставка-видна-оператору) /
[Message Deletion](message-deletion.md#исходы-и-оповещения-оператора).

## Оповещение оператора (M28)

О неудаче OL → MAX оператор узнаёт системным сообщением в чате ОЛ: Б24 событие не
повторяет, а ответ вебхука никто не видит. Один метод на все исходящие пути — отправку
(M22), правку и удаление — `messagingService.notifyOperator` →
`b24Service.sendSystemMessage` → `im.message.add` (`DIALOG_ID=chat<id>`, `SYSTEM=Y`,
`URL_PREVIEW=N`). Системное сообщение клиенту в MAX не уходит и в коннектор не
возвращается — петли нет. Б24 показывает над ним `MAXTOB24` (имя приложения). `REPLY_ID`
не передаём: у системного сообщения Б24 его не сохраняет (проба 2026-10-08), поэтому
оповещение не привязано к сообщению оператора.

```js
const r = await messagingService.notifyOperator({
  b24ChatId,        // id чата ОЛ без префикса chat: im.chat_id события, иначе binding.b24ChatId
  text,             // готовый текст из messaging/operatorNotices.js
  op: 'edit',       // 'send' | 'edit' | 'delete' — только для лога
  bindingId,        // для лога
  b24MsgId,         // сообщение оператора (не оповещения) — для лога
  installation,     // снимок из резолва привязки; null → b24 читает БД
  logger,           // null → логгер сервиса
});
// → { notified: true, noticeId } | { notified: false, reason: 'no-chat' | 'send-failed' }
```

- **Вне HTTP-запроса.** Ни `req`, ни `requestId` не нужны — метод можно звать и из фоновой
  работы.
- **Никогда не бросает и не повторяет.** Нет `b24ChatId` → `no-chat`; ошибка Б24 →
  `send-failed`. Повтор — дело вызывающего.
- **Чат ОЛ** — `im.chat_id` события, а если его нет — `b24_chat_id` привязки. Оповещение
  о внутренней ошибке — только по `im.chat_id`: привязка там неизвестна.
- **Тексты** собраны в `messaging/operatorNotices.js` — чистые функции без I/O. Имена
  файлов и причины экранируются от BB-кодов. Текст оповещения в лог не пишется (там имена
  файлов).
- **Без дедупа.** Неудача не пишет ключ в `message_log`: повтор события — новая попытка, и
  её неудача даёт новое оповещение.
- **Слишком длинный текст.** MAX принимает до 4000 символов текста — вместе с подписью
  оператора `**Имя:**\n` (схема MAX: `NewMessageBody.text` `maxLength: 4000` — одно тело у
  `POST` и `PUT /messages`; live 2026-10-09, правка на 4300 символов: HTTP 400
  `{"code":"proto.payload","message":"Field 'text' size (4321) must be at most 4000"}`; точная
  граница live не снималась). Мост текст не режет. Такой отказ оповещение называет явно, с
  подсказкой «сократите» вместо «ещё раз»: тот же текст не пройдёт.

  | Путь | Оповещение |
  |---|---|
  | отправка текста | `⚠️ Не доставлено в MAX: текст слишком длинный (4321 символ при лимите MAX 4000). Сократите текст или разбейте его на несколько сообщений.` |
  | правка | `⚠️ Правка не доставлена в MAX: текст слишком длинный (4321 символ при лимите MAX 4000). У клиентов осталась прежняя версия — сократите текст и отредактируйте сообщение ещё раз.` |
  | подпись к файлу | см. [Media Transfer](media-transfer.md#недоставка--системное-сообщение-оператору-m22) |

  Слово «символ» согласуется с числом; нет чисел в сообщении MAX — `текст слишком длинный
  для MAX`. Прочие 400 `proto.payload` — прежнее `MAX не принял (proto.payload)`.

| Лог | Когда |
|---|---|
| INFO `notifyOperator: operator notified` | оповещение ушло (`op`, `bindingId`, `b24MsgId`, `noticeId`) |
| WARN `notifyOperator: operator notification failed (non-fatal)` | `im.message.add` отказал (`b24Code`, `err`) |
| WARN `notifyOperator: no b24ChatId, operator not notified` | нет ни `im.chat_id` в событии, ни `b24_chat_id` у привязки (или привязка неизвестна) |

**installation — один раз на маршрут.** Резолв привязки (`resolveByConnectorChat`) уже
читает installation портала. Маршруты отправки, правки и удаления отдают этот снимок в
reply-резолв (`im.dialog.messages.search`), статус доставки и оповещение — без повторных
SELECT. Устаревший снимок не опасен: на `expired_token` `callMethod` обновляет токен из БД
и повторяет запрос. Оповещение о внутренней ошибке идёт без снимка — привязка там
неизвестна. Снимок из вебхука **не переносить** в отложенную работу (задание, ждавшее
своей очереди, восстановление на старте): токен мог обновиться, а без снимка `b24`
прочитает БД.

## Troubleshooting

| Симптом | Причина | Действие |
|---|---|---|
| `401 application_token mismatch` | `auth[application_token]` в событии ≠ `installation.b24ApplicationToken` | Проверить, что приложение установлено и ONAPPINSTALL отработал (лог `install verified: tokens saved`; отказы — `install rejected: …`, см. [app-installation.md](app-installation.md)). `b24_application_token` — в таблице `installations`. |
| `401 B24_MEMBER_MISMATCH` | `auth[member_id]` в событии ≠ `installations.b24_member_id` | Событие не от нашего портала. Если портал тот же (пересоздан) — обнулить `b24_member_id` и пересохранить форму приложения. |
| `503 B24_WEBHOOK_DISABLED` | `b24_application_token` пустой в installations | Пересохранить форму приложения (ONAPPINSTALL сохранит токен, см. [app-installation.md](app-installation.md)). |
| `503 B24_APP_UNINSTALLED` | приложение Б24 удалено (`ONAPPUNINSTALL`, `installations.uninstalled_at` стоит) | Переустановить приложение — порядок в [app-installation.md](app-installation.md#переустановка) (M26). |
| `skipped:'no-binding'` | `connectorChatId` (`chat.id` из события) не совпадает с `connector_chat_id` в `chat_bindings` | Проверить: `data.chat.id` совпадает с `connector_chat_id` в таблице `chat_bindings`? Убедиться, что inbound из этого чата хотя бы раз прошёл (авто-онбординг создаёт `connector_chat_id` при первом входящем). |
| `skipped:'no-messages'` | Событие с пустым `data.MESSAGES` | Норма (не все события от Б24 несут сообщения). |
| `maxClient: token is not configured` → 500 | `MAX_BOT_TOKEN` пустой | Добавить токен в `.env`, перестартовать api-node: `docker compose --profile node up -d --force-recreate api-node`. |
| В ОЛ «⚠️ Не доставлено в MAX: … MAX не принял (chat.denied)» | Бот удалён из группы или группа закрыта (`403 chat.denied`, live M22) | Вернуть бота в группу админом. |
| В ОЛ «⚠️ … текст слишком длинный (N символов при лимите MAX 4000)» | Текст вместе с подписью оператора длиннее 4000 символов (400 `proto.payload`, live 2026-10-09) | Оператор сокращает текст или разбивает его на несколько сообщений; правку — сокращает и редактирует ещё раз. |
| В ОЛ «⚠️ Сообщение могло не дойти до MAX: внутренняя ошибка моста», вебхук ответил 500 | Ошибка БД или баг (M28) | Причина — в ERROR-логе api-node с тем же `requestId`. Проверить, дошло ли сообщение в MAX-группу; если нет — оператор отправляет ещё раз. |
| Сбой есть в логе, а оповещения в ОЛ нет; WARN `notifyOperator: operator notification failed (non-fatal)` | `im.message.add` отказал: токен, права на чат ОЛ (`b24Code`) | Проверить токены `installations` (пересохранить форму приложения). Сама неудача — в ERROR маршрута. |
| MAX не получает сообщение (нет записи в лог) | `b24_access_token` протух | Переоткрыть локальное приложение в UI Б24 — токен обновится. |
| В ОЛ «⚠️ Не доставлено в MAX: … — мост перезапускался» | Передача прервана рестартом моста: дедлайн дренажа, `docker kill`, OOM, reboot VPS (M29) | Оператор отправляет ещё раз. Подробности и логи — [Outbound Queue](outbound-queue.md#troubleshooting). |
| Ответ на событие пришёл через десятки секунд (`responseTime`), `queuedMs` в `outbound job done` большой | Событие стояло в очереди чата за передачей файла (M29) | Норма для файлов — см. [Outbound Queue](outbound-queue.md#порядок-внутри-чата). |
| `routeOutbound: MAX send failed` + `delivery-failed` | Токен MAX не действителен, `chat_id` неверный, MAX недоступен | Проверить `MAX_BOT_TOKEN` и что бот — участник группы; причина — в `reason` лога и в системном сообщении оператору. |
| Событие не доходит до `/webhook/b24` | `B24_EVENT_HANDLER_URL` недостижим / событие не привязано | Проверить `make register-events ARGS="--list"`, проверить доступность публичного HTTPS (домен/туннель). |

## Реализовано в M5.3

- `imconnector.send.status.delivery` — галочка «доставлено» в OL реализована в
  [Formatting + Delivery](formatting-delivery.md) (best-effort, не валит outbound при провале).
- BB↔markdown форматирование подписи в MAX — реализовано в [Formatting + Delivery](formatting-delivery.md).

## Post-MVP (не в M5.2, не в M5.3)

- Медиа-вложения MAX → Б24 и обратно.
- `imconnector.send.status.reading` (галочка «прочитано»).

## См. также

- [Inbound Routing](inbound-routing.md) — M4.2: inbound MAX → Open Lines (зеркало этого runbook).
- [Formatting + Delivery](formatting-delivery.md) — M5.3: BB↔markdown форматирование и delivery-статус.
- [Message Editing](message-editing.md) / [Message Deletion](message-deletion.md) — правка и удаление OL → MAX, их оповещения оператору.
- [reply-quoting.md](reply-quoting.md) — нативный reply OL→MAX (добор `REPLY_ID`), встраиваемый в `routeOutbound`.
- [Outbound Queue](outbound-queue.md) — M29: очередь исходящих по чату, строки `job:`, остановка с дренажом, оповещение о прерванном.
- [webhooks.md](webhooks.md) — паттерн webhook-проверки (MAX secret, Б24 application_token).
- [architecture.md](architecture.md) — координатор `messagingService`, идемпотентность.
