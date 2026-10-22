[← Group Title & Icon](group-title-icon.md) · [Назад к README](../../README.md) · [Reply / Quoting →](reply-quoting.md)

# Группа как «Клиент» каждой сессии Open Lines

Каждую сессию Открытой линии открывает «группа», поэтому в журнале диалогов (колонка «Клиент») и в списке чатов контакт-центра видно имя и иконку MAX-группы, а не случайного участника.

**Почему это не делается «само».** У группы один чат ОЛ на все сессии: он переиспользуется после закрытия диалога. Но клиент (`USER_ID`) **каждой** сессии Б24 берёт у автора её первого сообщения. Первую сессию новой группы открывает интро ([Group Title & Icon](group-title-icon.md)). Со второй сессии клиентом снова становился тот, кто написал первым. Колонки с названием чата в журнале нет: свой текст коннектор может показать только через имя клиента.

**Решение (2026-10-07).** Закрытие диалога Б24 сообщает событием `OnImConnectorDialogFinish`. Мост помечает привязку, и перед следующим сообщением из MAX уходит служебное сообщение — **опенер** — от того же псевдо-пользователя «группа». Опенер открывает новую сессию, и её клиентом становится группа. Слать опенер сразу по событию нельзя: сообщение в закрытую сессию создаст новую, пустую, и она повиснет в очереди оператора.

**Второй сигнал (M27).** Б24 событий не повторяет: потерянный Finish оставлял следующую сессию без опенера. Если группу переименовали в MAX, пока диалог закрыт, мост узнаёт о закрытии ещё раз — по ответу `CHAT_RENAMING_FAILED` на переименование чата ОЛ, — и взводит тот же флаг. См. [ниже](#второй-сигнал-закрытия-chat_renaming_failed-m27).

## Поток

```
Оператор закрывает диалог
  → Б24 POST /webhook/b24  event=ONIMCONNECTORDIALOGFINISH
    → b24Controller → b24Service.handleOpenLineDialogFinish   (чужой коннектор → skip)
      → messagingService.routeDialogFinish
        → привязка: connector.chat_id (= chat.id = max:<chatId>) → connector_chat_id
        → bindingsService.markOlSessionClosed → chat_bindings.ol_closed_session_id = <session.id>

MAX webhook message_created (следующее сообщение группы)
  → routeInbound → _once(mid) → _deliverInbound
    → [ol_closed_session_id] _openGroupSessionSafe                 (под _serialized(bindingId))
      → перечитать привязку (флаг ещё стоит?)
      → _once('group-session:<chatId>:<закрытая сессия>:<mid>')
        → maxService.getChatInfo → GET /chats/{id}                 (title, icon.url, type, link)
        → b24Service.sendConnectorMessage                          (опенер от «группы»)
        → bindingsService.completeSessionOpener                    (флаг снят, сессия запомнена)
      → _postGroupLinkSafe                    (там же, сразу после опенера: ссылка, если её с этим хешем ещё не постили, M27)
    → b24Service.sendConnectorMessage                              (сообщение автора)
    → _noteOlSessionSafe                                           (session.ID ответа → ol_session_id)

Группу переименовали в MAX при закрытом диалоге (M27)
  → MAX webhook chat_title_changed → routeChatTitleChanged → _syncOlTitleSafe(armOnClosed)
    → b24Service.setChatName → imconnector.chat.name.set → 400 CHAT_RENAMING_FAILED
    → _onOlRenameFailed → b24Service.getOlChat → imopenlines.dialog.get {CHAT_ID}
      → [поле 6 entity_data_1 = 0] bindingsService.markOlSessionClosedByRename
        → chat_bindings.ol_closed_session_id = ol_session_id (NULL → 0)
```

## Событие `OnImConnectorDialogFinish`

Scope `imconnector`, онлайн-подписка через `event.bind` на `/webhook/b24` (`register-events`). Офлайн-очередь (`event_type: offline`) это событие не получает: проба 2026-10-07 дала 0 событий. Онлайн оно приходит примерно через 1,6 с после закрытия. В нём есть `auth.application_token` и `auth.member_id`, проверки контроллера те же, что у сообщений.

```
data.CONNECTOR, data.LINE,
data.DATA[] = {connector{connector_id, line_id, chat_id, user_id},
               session{id, closed: "Y", parent_id, close_term},
               chat{id}, user{id}}
```

- **Привязка** ищется по внешнему id чата коннектора: `connector.chat_id` = `chat_bindings.connector_chat_id` (`max:<chatId>`). Live (2026-10-08): Б24 кладёт тот же внешний id и в `chat.id` (не id чата Б24), поэтому `chat.id` — запасной источник того же значения. В доке Б24 оба поля описаны как целые, на деле — строка `max:<chatId>`.
- **Чужие каналы.** Подписаться на событие может любой пользователь, а на портале есть другие коннекторы. Если `CONNECTOR` события не наш (`installations.b24_connector_id`), ответ `skipped: foreign-connector`. Чат без привязки (пробный, чужой) — `skipped: no-binding`.
- **Б24 событие не повторяет.** Если мост его не принял (деплой, 5xx), клиентом следующей сессии станет автор, как до M25. В лог пишется INFO `OL session changed without DialogFinish`. Исключение — группу переименовали при закрытом диалоге: тогда флаг взводит второй сигнал (ниже).

## Второй сигнал закрытия: `CHAT_RENAMING_FAILED` (M27)

На `chat_title_changed` мост переименовывает чат ОЛ через `imconnector.chat.name.set` ([Group Title & Icon](group-title-icon.md#название-чата)). Если сессия закрыта, Б24 отвечает HTTP 400 `CHAT_RENAMING_FAILED`. Но тот же код он даёт и на открытой сессии, если имя не меняется (проба 2026-10-08), поэтому один код ответа — не признак. Мост читает чат ОЛ: `imopenlines.dialog.get {CHAT_ID: <b24_chat_id>}`. Поле 6 `entity_data_1` — id текущей сессии, у закрытой Б24 пишет туда `0`.

- **Поле 6 = `0`** → флаг взводится (`bindingsService.markOlSessionClosedByRename`), INFO `routeChatTitleChanged: OL session closed (CHAT_RENAMING_FAILED), group opener armed`. Номер закрытой сессии — `ol_session_id` привязки, guard'ы те же, что у Finish (ниже). Если Finish уже дошёл, флаг тот же — INFO `… opener already armed`, опенер уйдёт один.
- **Привязка своей сессии не знает** (`ol_session_id` NULL — например, у группы, из которой после выката M25 ещё не писали) → флаг `0`: «сессия закрыта, номер неизвестен». Опенер уйдёт с ключом `group-session:<chatId>:0:<mid>`.
- **Поле 6 > 0** (сессия открыта), `dialog.get` упал или поле не разобрать → флаг не взводится: ошибка в безопасную сторону. Что при этом происходит с названием — [Group Title & Icon](group-title-icon.md#ответ-chat_renaming_failed-m27).
- **Только `chat_title_changed`.** После входящего сообщения тот же ответ флаг не взводит: сессия только что получила сообщение, и `0` там означает гонку с закрытием, а не потерянный Finish.
- **Ошибка БД при взведении** → WARN `routeChatTitleChanged: OL chat title sync failed …` с `step: 'arm-opener'`, вебхук отвечает 200 (`olTitle: failed`), флаг не взведён. Ответ 500 не помог бы: ретрай MAX отсёк бы `_once` как дубль.

**Общий случай не закрыт.** Finish потерян, а группу не переименовывали → следующую сессию откроет автор, как раньше (INFO `OL session changed without DialogFinish`). Проверять `dialog.get` на каждом входящем мост не стал: это лишний REST в горячем пути.

## Состояние на привязке (миграция `0011`)

| Колонка | Смысл | Кто пишет |
|---|---|---|
| `ol_session_id` | последняя известная сессия ОЛ, растёт монотонно | ответ `send.messages` (`session.ID`) и событие Finish |
| `ol_closed_session_id` | закрытая сессия: по Finish или, с M27, по `CHAT_RENAMING_FAILED`. `0` — сессия закрыта, номер неизвестен (M27). Не NULL — перед следующим входящим нужен опенер | Finish или `chat_title_changed` взводят, опенер или сообщение в более новую сессию снимают |

Тип `integer` (в Б24 id сессии — int). Бэкфилла нет: NULL — сессия неизвестна, опенер не нужен. Guard'ы — в SQL репозитория:

- **Устаревший Finish.** Если `session.id` события меньше `ol_session_id`, флаг не взводится (`skipped: stale-session`). Так бывает, когда сообщение из MAX успело открыть новую сессию раньше, чем дошло событие. Иначе опенер встал бы посреди сессии.
- **Повтор события** про ту же сессию — `skipped: already-marked`.
- **Флаг снимает** опенер (compare-and-clear по закрытой сессии) или любое сообщение, ушедшее в сессию **строго** новее закрытой. Равенство флаг не снимает: Finish мог прийти между отправкой и записью.
- **Флаг `0`** (M27, `markOlSessionClosedUnknown`) взводится только при `ol_session_id` NULL и без флага: если входящее уже открыло сессию, флаг без номера не нужен. Finish с номером сессии его перезаписывает, первая же известная сессия снимает (`0 <` любого id).

Finish в `message_log` не пишется. Внешнего эффекта у него нет, UPDATE идемпотентен за счёт guard'ов. Дедуп по `session.id` сломал бы повторное закрытие возобновлённой сессии. Аудит — INFO-лог `routeDialogFinish` и запись опенера в `message_log` (`payload_meta.closedSessionId`).

## Опенер

| Поле `imconnector.send.messages` | Значение |
|---|---|
| `user.id` | `group:<chatId>` — тот же пользователь коннектора, что у интро |
| `user.name` | название из `GET /chats/{id}`, при сбое — `chat_bindings.max_chat_title`. Санитизация как у интро, из одних эмодзи → «Группа MAX» |
| `user.picture.url` | актуальная `Chat.icon.url`. Иконку могли сменить, а события смены иконки в MAX нет. Иконки нет или запрос упал → поле не шлём, аватар пользователя не сбрасывается |
| `message.id` | `max:group-session:<chatId>:<закрытая сессия>:<mid>`; при флаге `0` — `max:group-session:<chatId>:0:<mid>` |
| `message.text` | `Новое обращение из группы «<название>» в MAX` (BB-теги экранированы) |
| `message.date` | дата сообщения, перед которым уходит опенер |

- **Очерёдность.** Под `_serialized(bindingId)` опенер перечитывает привязку. При «пачке» сообщений после закрытия уходит один опенер: следующий запрос видит флаг уже снятым. Ссылка на группу (если уходит) постится под той же блокировкой, поэтому сообщения пачки идут после опенера и ссылки.
- **Дедуп.** `_once` по ключу с `mid`: ретрай MAX того же сообщения второй опенер не шлёт (`duplicate-opener`). Если Б24 вдруг возобновит закрытую сессию и её закроют повторно, она снова откроется группой.
- **Название в привязке не меняется.** `max_chat_title` синхронизирует `chat_title_changed` ([Group Title & Icon](group-title-icon.md)). Опенер только показывает свежее название в имени клиента, переименования чата ОЛ по нему нет.
- **Не уходит**, флаг снимается: чат не группа (`type` ≠ `chat`) или названия нет ни в MAX, ни в привязке. Иначе `GET /chats` дёргался бы на каждое сообщение.
- **Best-effort.** Сбой опенера — WARN `group session opener failed`, сообщение автора доставляется. Клиентом сессии тогда станет автор, а флаг снимется по сессии этого сообщения.
- **Reply оператора на опенер** уходит в MAX без `link`, как на интро — см. [Reply / Quoting](reply-quoting.md#маппинг-в-max-mid-_resolvereplymaxmid).
- **Ссылка на группу (M27).** Опенер делает свежий `GET /chats`. Если записи с хешем текущей ссылки в журнале нет (MAX перевыпустил ссылку или прошлый пост не удался), после опенера, до сообщения автора, в чат ОЛ уходит системное сообщение со ссылкой. С прежней ссылкой — ничего, только индексный SELECT. Подробно — [Group Title & Icon](group-title-icon.md#ссылка-на-группу-m27).

## Влияние и ограничения

- **KPI операторов.** Опенер — сообщение клиента с той же датой, что и реальное, поэтому время ответа почти не меняется. Счётчик «Сообщений» в журнале растёт на одно на каждую сессию.
- **Приветствие линии.** На линии 42 `SEND_WELCOME_EACH_SESSION=N`: опенер приветствие не добавляет.
- **Сессии, закрытые до выката M25,** мост пропустит. Следующую сессию каждой такой группы откроет автор, дальше всё работает по новой схеме (осознанно: один промах на группу, без догона).
- **Старые привязки (до M24).** Опенер делает клиентом группу и в них. Название и аватар самого чата ОЛ не меняются, догона нет.
- **Потерянный Finish без переименования группы.** Второй сигнал (M27) есть только у переименования при закрытом диалоге. В остальных случаях потерянный Finish по-прежнему оставляет следующую сессию автору.
- **Гонка «сообщение раньше события».** Если сообщение из MAX пришло раньше Finish, клиентом новой сессии станет автор. Устаревший Finish потом отсекается.
- **Один процесс.** `_serialized` работает внутри процесса, как в M24.
- **Выключатель.** `event.unbind` для `OnImConnectorDialogFinish`: флаги по Finish перестанут взводиться. Второй сигнал (переименование при закрытом диалоге, M27) от подписки не зависит и продолжит взводить флаг.

## Ключевые файлы

| Файл | Роль |
|---|---|
| `src/shared/db/migrations/0011_chat_bindings_ol_session.sql` | `ol_session_id`, `ol_closed_session_id` |
| `src/modules/bindings/models/ChatBinding.js` | `needsSessionOpener()` (`0` — тоже флаг), `isStaleSessionFinish()` |
| `src/modules/bindings/bindingsRepository.js` | `updateOlSession`, `markOlSessionClosed`, `markOlSessionClosedUnknown` (флаг `0`, M27), `clearOlClosedSession` — guard'ы SQL |
| `src/modules/bindings/bindingsService.js` | `markOlSessionClosed`, `markOlSessionClosedByRename` (M27), `completeSessionOpener` (принимает закрытую сессию `0`) |
| `src/modules/b24/models/OpenLineEvent.js` | `isDialogFinish()`, `normalizedDialogs()` |
| `src/modules/b24/b24Controller.js`, `b24Service.js` | роут события, отсечение чужого коннектора; `getOlChat`, `parseLinesSessionId` — поле 6 `entity_data_1` (M27) |
| `src/modules/messaging/messagingService.js` | `routeDialogFinish`, `_openGroupSessionSafe`, `_noteOlSessionSafe`, `_sendAsGroup`; `_onOlRenameFailed` — второй сигнал закрытия, `_postGroupLinkSafe` — ссылка после опенера (M27) |
| `scripts/register-events.js` | подписка на `OnImConnectorDialogFinish` |
| `tests/messaging/messagingService.session.test.js` | опенер и `routeDialogFinish`; M27-1…3 — флаг `0`, переименование при закрытой сессии, входящий путь без флага |
| `tests/inbound-group-session.smoke.test.js`, `tests/bindings/bindingsRepository.olSession.int.test.js` | сквозные сценарии (5–7 — второй сигнал и ссылка на опенере, M27) и guard'ы SQL на БД (в том числе флаг `0`) |

## Выкат

1. `make deploy APPLY=1` — миграция `0011`. С M26 деплой применяет миграцию one-off контейнером до пересоздания `api` ([migrations.md](migrations.md)): прежний код какое-то время работает на новой схеме, поэтому миграции — только расширяющие. Штатного окна «новый код на старой схеме» больше нет (оно было при выкате M25, до M26). Терпимость `ChatBinding.fromRow` к отсутствию колонок (NULL) и best-effort запись сессии остались страховкой на случай кода без миграции — например, `FROM=up` после упавшего `migrate`.
2. На VPS: `make register-events` (доподпишет только новое событие) → `make register-events ARGS="--list"`, в списке четыре события на `/webhook/b24` (с M26 — пять: добавилось `ONAPPUNINSTALL`, см. [App Installation](app-installation.md#удаление-и-переустановка-m26)).

Второму сигналу (M27) не нужны ни миграция, ни новые подписки: флаг `0` пишется в ту же колонку `ol_closed_session_id`, а `chat_title_changed` уже в подписке MAX с M24. Откат кода на версию до M27 безопасен: флаг `0` снимет первая же известная сессия (`0 <` id сессии), а записи `group-link:` старый код не читает.

## Ручная проверка

1. Закрыть диалог группы в ОЛ → в логе api-node INFO `routeDialogFinish: OL session closed, group opener armed`.
2. Написать в группу в MAX → в ОЛ первым идёт «Новое обращение из группы «…» в MAX», за ним — сообщение. В контакт-центре и журнале диалогов клиент сессии — группа (имя и иконка).
3. Второе сообщение той же сессии — без опенера.
4. (M27) Закрыть диалог и переименовать группу в MAX → в логе INFO `routeChatTitleChanged: OL session closed (CHAT_RENAMING_FAILED), group opener armed` (или `… opener already armed`, если Finish дошёл). Следующее сообщение из MAX → опенер, сообщение, затем новое название чата.

БД:

```sql
SELECT id, max_chat_id, ol_session_id, ol_closed_session_id FROM chat_bindings ORDER BY id;
SELECT max_mid, payload_meta FROM message_log WHERE max_mid LIKE 'group-session:%' ORDER BY id DESC LIMIT 10;
```

## Troubleshooting

| Симптом | Причина | Действие |
|---|---|---|
| Клиент новой сессии — человек, в логе нет `routeDialogFinish` | Событие не подписано или не дошло | `register-events --list` → нет `ONIMCONNECTORDIALOGFINISH` → `make register-events` на VPS. Пропущенное событие Б24 не повторит |
| INFO `OL session changed without DialogFinish` | Сессия сменилась, а Finish мост не принял (деплой, 5xx, не было подписки) | Разово — норма. Если на каждой сессии — проверить подписку |
| INFO `no binding (foreign or probe chat)` | Чат не наш (пробный, другой коннектор с тем же кодом) либо `connector.chat_id` не совпал с привязкой | Сверить `connectorChatId` в логе `OL dialog finished` с `chat_bindings.connector_chat_id` |
| INFO `stale finish` | Сообщение из MAX открыло новую сессию раньше, чем дошло событие | Норма: эту сессию открыл автор |
| WARN `group session opener failed` | Б24 отклонил опенер или упал `GET /chats` | Смотреть `b24Code`. Сообщение доставлено, клиентом сессии стал автор |
| Опенер посреди сессии | Флаг взвёлся после того, как сессия уже открылась | Проверить `ol_session_id` и порядок событий в логе (`stale finish` должен отсекать) |
| `ol_closed_session_id = 0` | Второй сигнал (M27) у привязки без `ol_session_id`: сессия закрыта, номер неизвестен | Норма: опенер уйдёт перед следующим входящим (`group-session:<chatId>:0:<mid>`) и снимет флаг |
| INFO `routeChatTitleChanged: … opener already armed` | Finish дошёл раньше переименования, флаг уже стоит | Норма: опенер один |
| WARN `routeChatTitleChanged: OL chat title sync failed` с `step: 'arm-opener'` | Ошибка БД при взведении флага по `CHAT_RENAMING_FAILED` | Флаг не взведён, вебхук ответил 200. Если Finish тоже потерян, следующую сессию откроет автор. Проверить БД |
| Группу переименовали при закрытом диалоге, а флага нет | `dialog.get` не прочитал чат (WARN `b24.getOlChat: failed`) или поле 6 не `0` (INFO `rename failed with open session` / `chat title pending (OL chat state unknown)`) | Флаг взводится только при поле 6 = `0`. Сверить `entity_data_1` из `imopenlines.dialog.get {CHAT_ID: <b24_chat_id>}` |

## See Also

- [Group Title & Icon](group-title-icon.md) — интро группы (первая сессия), название чата ОЛ, `CHAT_RENAMING_FAILED`, ссылка на группу
- [Inbound Routing](inbound-routing.md) — поток входящих
- [Webhooks](webhooks.md) — `/webhook/b24`, каркас `_once` и синтетические ключи
- [Migrations](migrations.md) — `0011`
