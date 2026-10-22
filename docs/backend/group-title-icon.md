[← Membership Notifications](group-membership-notifications.md) · [Назад к README](../../README.md) · [Group Session Opener →](group-session-opener.md)

# Название и иконка MAX-группы в чате Open Lines

Чат Open Lines получает название и иконку MAX-группы, а не имя и фото случайного автора. Если группу переименовали в MAX, новое название доходит до ОЛ. С M27 оператор видит в чате ещё и ссылку на группу в MAX — системным сообщением ([ниже](#ссылка-на-группу-m27)).

**Почему это не делается «само».** Б24 создаёт чат линии один раз: при первом сообщении по `chat.id` коннектора. Заголовок он ставит по шаблону «`<имя клиента>` - `<линия>`», а аватар копирует с фото этого клиента. Клиент — автор первого сообщения. `chat.name` из `imconnector.send.messages` imopenlines не читает, а отдельного REST для аватара чата у `imconnector.*` нет. Поэтому:

- **иконка** — первым в новый чат пишет псевдо-пользователь коннектора «группа», и Б24 сам ставит его фото аватаром чата;
- **название** — точное название ставит `imconnector.chat.name.set`.

Пробы на портале 2026-10-07 подтвердили оба шага.

## Поток

```
MAX webhook message_created (новая группа или чат ОЛ ещё неизвестен)
  → messagingService.routeInbound
    → [нет привязки] bindingsService.ensureForMaxChat
    → _once(mid) → _deliverInbound
      → [b24ChatId пуст] _introduceGroupSafe              (под _serialized(bindingId))
        → _once('group-intro:<chatId>')
          → [привязка не новая] b24Service.resolveB24ChatId   (чат есть → только персист адреса)
          → maxService.getChatInfo → GET /chats/{id}           (title, icon.url, type, link)
          → bindingsService.updateMaxChatTitle
          → b24Service.sendConnectorMessage                    (интро от «группы»)
        → _postGroupLinkSafe                                   (ссылка на группу, M27)
          → _once('group-link:<chatId>:<hash>') → b24Service.sendSystemMessage → im.message.add
      → b24Service.sendConnectorMessage                        (сообщение автора)
    → _syncOlTitleSafe                                        (после записи в message_log)
      → b24Service.setChatName → imconnector.chat.name.set
      → bindingsService.markOlChatTitle
      → [400 CHAT_RENAMING_FAILED] _onOlRenameFailed → b24Service.getOlChat
                                   → imopenlines.dialog.get {CHAT_ID}  (M27)
    → _ensureGroupLinkSafe                                    (старая привязка без ссылки, M27)

MAX webhook chat_title_changed
  → maxService.handleChatTitleChanged → messagingService.routeChatTitleChanged
    → _once('chat_title_changed:<chatId>:<timestamp>') → bindingsService.updateMaxChatTitle
    → _syncOlTitleSafe(armOnClosed)
      → [CHAT_RENAMING_FAILED, сессия закрыта] bindingsService.markOlSessionClosedByRename
                                                (флаг опенера, M27)
```

## Интро группы

Первое сообщение нового чата ОЛ — от пользователя коннектора «группа»:

| Поле `imconnector.send.messages` | Значение |
|---|---|
| `user.id` | `group:<chatId>` (MAX `user_id` числовые — коллизий нет) |
| `user.name` | название группы; санитизация как у авторов ([Inbound Routing](inbound-routing.md#имя-автора-в-б24)): ≤ 50 символов, без символов вне BMP; из одних эмодзи → «Группа MAX» |
| `user.picture.url` | `Chat.icon.url` — публичный webp на `i.oneme.ru`, Б24 качает сам. Иконки нет → поле не шлём, аватар чата пустой (не фото автора) |
| `message.id` | `max:group-intro:<chatId>` |
| `message.text` | `Группа «<название>» в MAX подключена к Открытой линии` (BB-теги названия экранированы) |

**Когда уходит.** Пока адрес чата ОЛ (`chat_bindings.b24_chat_id`) неизвестен. Обычно это первое сообщение группы. Если Б24 был недоступен на первом сообщении, интро уйдёт на ретрае MAX — триггер постоянный, а не «привязку только что создали».

**Дедуп.** Запись в `message_log` с ключом `group-intro:<chatId>`. После успеха `b24_chat_id` берётся из `session.CHAT_ID` ответа интро. Если привязка не новая (ретрай или старая привязка без адреса), сначала `imopenlines.dialog.get` по USER_CODE. Если чат уже есть — интро не шлём, только сохраняем адрес.

**Не уходит:** `GET /chats/{id}` упал или вернул пустое название; чат не группа (`type` ≠ `chat`). Тогда чат создаст автор, как до M24.

**Best-effort.** Любая ошибка интро — WARN `group intro failed`, реальное сообщение доставляется как обычно.

**Reply оператора на интро.** У интро `CONNECTOR_MID` = `max:group-intro:…`, сообщения в MAX за ним нет. Ответ уходит в MAX без `link` — см. [Reply / Quoting](reply-quoting.md#маппинг-в-max-mid-_resolvereplymaxmid).

## Ссылка на группу (M27)

Группы клиентов в MAX обычно приватные, и по названию оператор группу не найдёт. Поэтому мост кладёт в чат ОЛ ссылку-приглашение на группу — системным сообщением:

```
MAXTOB24
Ссылка на группу в MAX: https://max.ru/join/…
```

- **Механизм** тот же, что у [уведомлений о составе группы](group-membership-notifications.md): `im.message.add {DIALOG_ID: chat<b24_chat_id>, SYSTEM: Y, URL_PREVIEW: N}`. Сообщение видят операторы. В коннектор и в MAX оно не уходит, сессию не открывает (проба на портале 2026-10-08). Строку `MAXTOB24` (имя приложения) Б24 сам ставит перед системным сообщением приложения, поэтому своего заголовка у текста нет.
- **Ссылка** — `Chat.link` из `GET /chats/{id}`: invite-ссылка `https://max.ru/join/…`, она есть и у приватных групп. `maxService.getChatInfo` пропускает только `https://…` без пробелов и `[`/`]`, не длиннее 2048 символов: ссылка встаёт в BB-разметку сообщения. Иначе ссылки нет. BB-теги в тексте всё равно экранируются, как в любом тексте из MAX.

**Когда уходит:**

| Случай | Когда | `payload_meta.via` |
|---|---|---|
| Новая группа | сразу после интро, до сообщения автора: ссылка встаёт под сообщением «группы». Лишнего `GET /chats` нет — ссылку берёт запрос интро | `intro` |
| Старая привязка без записи `group-link:` — группа подключена до M27, или прошлый пост не удался, и api-node с тех пор перезапускался | один раз за процесс, на первом входящем группы после старта api-node (выкат, рестарт) — после доставки и записи сообщения, рядом с синхронизацией названия. Доставку не задерживает, только ответ вебхука | `lazy` |
| MAX перевыпустил ссылку | на [опенере](group-session-opener.md) новой сессии: опенер и так делает свежий `GET /chats`. Сообщение — после опенера, до сообщения автора. С прежней ссылкой опенер ничего не шлёт | `opener` |

- **Дедуп.** Ключ `message_log` — `group-link:<chatId>:<hash>`, `<hash>` — первые 16 hex sha256 ссылки. Одна и та же ссылка уходит один раз, перевыпущенная — под новым ключом. Пост идёт под `_serialized(bindingId)` + `_once`, после интро и опенера — под той же блокировкой, что и они: два параллельных первых сообщения дают одно системное сообщение, и сообщение автора не встаёт между интро (опенером) и ссылкой. Саму ссылку мост не пишет ни в журнал (`payload_meta` = `{kind: 'group-link', via, b24MsgId}`), ни в логи: это приглашение в закрытую группу клиента.
- **«Уже постили?» у старой привязки.** Кэш в памяти процесса (`_linkChecked`), за ним один SELECT `starts_with(max_mid, 'group-link:<chatId>:')` по строкам привязки (`messageLogRepository.hasInboundKeyPrefix`). Привязка попадает в кэш до любого `GET /chats` — в интро, на опенере или в ленивом шаге. Итого: один SELECT на привязку за жизнь процесса, `GET /chats` — только если записи ещё нет. После рестарта или деплоя запись находится, повторного сообщения нет.
- **Не уходит:** у группы нет ссылки; чат не группа (`type` ≠ `chat`). Если адрес чата ОЛ (`b24_chat_id`) на момент поста неизвестен (интро не вернуло `CHAT_ID`; DEBUG `routeInbound: OL chat address unknown, group link not posted`), ссылка уйдёт на следующем опенере или после рестарта api-node: шаг ссылки в этом процессе уже был. До следующего входящего ленивый шаг ждёт адреса, только если в этом процессе шага ссылки по группе ещё не было.
- **Отзыв ссылки.** MAX вернул `link: null` → мост ничего не шлёт, прежнее сообщение в чате остаётся. Перевыпуск заметен только на опенере: в `chat_title_changed` ссылки нет, и отдельного `GET /chats` там не делается.
- **Best-effort.** Сбой `GET /chats` (WARN `getChatInfo failed`), `im.message.add` (WARN `routeInbound: group link post failed (best-effort)`) или SELECT (WARN `routeInbound: group link check failed (best-effort)`) → записи нет, сообщение автора доставлено, вебхук отвечает 200. Внутри процесса повтора нет, чтобы не дёргать упавший сервис на каждом сообщении. Повтор — на следующем опенере или после рестарта api-node.
- **Цена.** Пост после интро или опенера — +1 `im.message.add` (~0,3 с) перед сообщением автора, только при первом посте или перевыпуске. Опенер с прежней ссылкой платит одним индексным SELECT.

Удачный пост — INFO `routeInbound: group link posted to Open Line chat` (`via`, `b24MsgId`).

## Название чата

`chat_bindings` хранит два названия:

| Колонка | Смысл |
|---|---|
| `max_chat_title` | название группы в MAX: из `GET /chats` при интро и из `chat_title_changed` |
| `ol_chat_title` | название, которое мы последним поставили в чат ОЛ (миграция `0010`) |

`ChatBinding.needsOlTitleSync()` — `max_chat_title` непустой и отличается от `ol_chat_title`. Тогда после доставки входящего (сессия открыта) координатор вызывает:

`imconnector.chat.name.set {CONNECTOR, LINE, CHAT_ID: max:<chatId>, NAME}` (контекст приложения; `USER_ID` при `CHAT_GROUP=true` не нужен). Затем пишет `ol_chat_title`.

- Название ставится как есть: в отличие от имени пользователя, заголовок чата принимает эмодзи и > 50 символов (проба: 142 символа).
- Вызов — после записи сообщения в `message_log`, не внутри эффекта: лишний REST между отправкой и записью расширил бы окно duplicate-race.
- **HTTP 400 `CHAT_RENAMING_FAILED`** — сессия закрыта либо имя не меняется, разбор — [ниже](#ответ-chat_renaming_failed-m27). `pending` значит: `ol_chat_title` не меняется, название применится на следующем входящем.
- Другие ошибки — WARN `OL chat title sync failed (best-effort, will retry on next inbound)`, тоже до следующего входящего.

**`chat_title_changed`** (`{chat_id, user, title}`). Название пишется в `max_chat_title` под `_once`; ошибка БД → 500 → MAX ретраит. Затем — попытка переименовать. Ответ — 200 с `olTitle: synced | pending | failed`. Если сессия закрыта, переименование ещё и взводит флаг опенера (M27, ниже). Неподключённую группу не онбордим (`skipped: no-binding`): название возьмёт интро.

### Ответ `CHAT_RENAMING_FAILED` (M27)

Б24 отвечает HTTP 400 `CHAT_RENAMING_FAILED` в двух случаях: сессия закрыта, или сессия открыта, но имя не меняется (в том числе отличается только пробелом в конце; проба 2026-10-08). Чтобы их различить, координатор (`_onOlRenameFailed`) читает чат ОЛ: `imopenlines.dialog.get {CHAT_ID: <b24_chat_id>}` → `b24Service.getOlChat`. В ответе `entity_data_1` = `CRM|CRM_ENTITY_TYPE|CRM_ENTITY_ID|PAUSE|WAIT_ACTION|SESSION_ID|DATE_CREATE|…`: поле 6 — id текущей сессии, при закрытии Б24 пишет туда `0` (`parseLinesSessionId`).

| Состояние чата ОЛ | Входящее (после доставки) | `chat_title_changed` |
|---|---|---|
| Поле 6 = `0` — сессия закрыта | `pending`, INFO `OL session closed, chat title pending until next inbound`. Флага нет: сессия только что получила сообщение, `0` здесь — гонка с закрытием | `pending` и флаг опенера: INFO `OL session closed (CHAT_RENAMING_FAILED), group opener armed`, или `… opener already armed`, если Finish уже дошёл — [Group Session Opener](group-session-opener.md#второй-сигнал-закрытия-chat_renaming_failed-m27) |
| Поле 6 > 0, имя в ОЛ уже равно названию | `synced`: отметка `ol_chat_title`, INFO `OL chat already has this title`. На следующем входящем `chat.name.set` не зовётся | то же |
| Поле 6 > 0, имя другое | `pending`, INFO `rename failed with open session, chat title pending` | то же, без флага |
| `dialog.get` упал, `b24_chat_id` пуст или поле 6 не разобрать | `pending`, INFO `chat title pending (OL chat state unknown)` | то же, без флага (безопасная сторона) |

Логи — с префиксом `routeInbound:` или `routeChatTitleChanged:`. Сам `dialog.get` пишет INFO `b24.getOlChat: ok` (`b24ChatId`, `nameLen`, `sessionId` — без имени) или WARN `b24.getOlChat: failed (best-effort, returning null)`.

**Сравнение имени** (`olChatTitle.sameOlTitle`) повторяет правило Б24 (`CIMChat::Rename`): пробелы по краям обрезаются как PHP `trim` (только ` \t\n\r\0\x0B`, не NBSP), берутся первые 255 символов, сравнение строгое. «Числовые» названия вроде `1e3` и `1000` Б24 считает равными, а мост — нет: выйдет `pending`, флага на открытой сессии всё равно не будет.

**Ошибка БД при взведении флага** → WARN `routeChatTitleChanged: OL chat title sync failed …` с `step: 'arm-opener'`, `olTitle: failed`, вебхук отвечает 200, флаг не взведён. Ответ 500 не помог бы: ретрай MAX отсёк бы `_once` как дубль.

**MAX главный.** Переименование в MAX перезатирает ручное имя оператора.

**Очерёдность.** Интро и переименования по одной привязке выполняются по очереди (`_serialized` — FIFO по `bindingId` на своём экземпляре `KeyedQueue`, не на очереди исходящих: шаги привязки не ждут заливку файлов). Поэтому:
- при «пачке» первых сообщений в новой группе уходит одно интро, и сообщения идут после него и после ссылки на группу (M27);
- переименование перечитывает привязку и не оставит в ОЛ устаревшее название.

Блокировка — внутри процесса: api-node работает одним процессом (single-tenant). При горизонтальном масштабировании её пришлось бы заменить.

## Подписка на `chat_title_changed`

Тип входит в дефолт `MAX_WEBHOOK_UPDATE_TYPES` (см. [env.md](env.md)). У существующей подписки его нет: `register-webhook` в режиме по умолчанию пишет warn о расхождении `update_types`, а обновляет подписку только с `--force` — см. [MAX Webhook Setup](max-webhook-setup.md#обновить-список-событий---force). Бот общий с продом — запускать только на прод-VPS.

## Ограничения

- **Иконка синхронизируется только при создании чата.** События смены иконки в MAX нет. Сменить аватар существующего чата можно через `im.chat.updateAvatar`, но только от участника чата: для этого нужен `imopenlines.session.join` установщика в открытой сессии. Это не делается.
- **Существующие чаты не трогаем.** Миграция `0010` ставит `ol_chat_title = max_chat_title`: у старых чатов названия и аватары, которые поставил оператор или Б24, остаются. Новое название придёт только после переименования группы в MAX. Догона названий и аватаров старых чатов нет: боевые чаты операторы уже переименовали сами. Старым чатам M27 добавляет только ссылку на группу.
- **Ссылку видят все, кто открывает чат ОЛ**, и по ней можно вступить в группу клиента. Закрепить сообщение со ссылкой оператор может сам, мост этого не делает.
- Интро открывает сессию: оно первым попадает в очередь оператора, клиент первой сессии — «группа». Приветствие линии (если настроено) уходит в MAX, как и раньше. Следующие сессии открывает опенер — [Group Session Opener](group-session-opener.md) (M25).

## Ключевые файлы

| Файл | Роль |
|---|---|
| `src/shared/db/migrations/0010_chat_bindings_ol_chat_title.sql` | колонка `ol_chat_title` + бэкфилл |
| `src/modules/bindings/models/ChatBinding.js` | `olChatTitle`, `needsOlTitleSync()`, `fromRow` до миграции |
| `src/modules/bindings/bindingsService.js` | `updateMaxChatTitle`, `markOlChatTitle`, `markOlSessionClosedByRename` (M27) |
| `src/modules/messaging/messagingService.js` | `_introduceGroupSafe`, `_sendAsGroup` (общая отправка от «группы», M25), `_syncOlTitleSafe`, `_onOlRenameFailed` (M27), `_postGroupLinkSafe`, `_ensureGroupLinkSafe`, `groupLinkKey`/`groupLinkText` (M27), `_serialized`, `routeChatTitleChanged`, `_resolveReplyMaxMid` |
| `src/modules/messaging/olChatTitle.js` | `sameOlTitle` — сравнение имени по правилу Б24 (M27) |
| `src/modules/messaging/messageLogRepository.js` | `hasInboundKeyPrefix` — есть ли у привязки запись `group-link:` (M27) |
| `src/modules/b24/b24Service.js`, `b24Client.js` | `setChatName` / `imconnectorChatNameSet`; `getOlChat`, `parseLinesSessionId` / `imDialogGet({ chatId })` (M27); `sendSystemMessage` / `imMessageAdd` |
| `src/modules/b24/connectorUserName.js` | санитизация имени, `fallbackName` |
| `src/modules/max/maxService.js` | `getChatInfo` (с M27 — и `link`), `handleChatTitleChanged` |
| `src/modules/max/models/MaxUpdate.js`, `maxController.js` | разбор и роут `chat_title_changed` |
| `scripts/register-webhook.js` | расхождение `update_types`, `--force` |
| `tests/messaging/messagingService.test.js` | M24-1…14 (M24-13…13e — `CHAT_RENAMING_FAILED`), `routeChatTitleChanged` 1…9 (2…2g — флаг опенера и `already`, M27) |
| `tests/messaging/messagingService.groupLink.test.js` | ссылка на группу: интро, ленивый шаг, опенер, сбои (M27) |
| `tests/messaging/olChatTitle.test.js`, `tests/messaging/messageLogRepository.prefix.int.test.js` | `sameOlTitle`; поиск по префиксу ключа на БД (M27) |
| `tests/inbound-group-intro.smoke.test.js` | сквозные сценарии с БД, в том числе `CHAT_RENAMING_FAILED` (2, 2b, 2c) и ссылка (6–9) |

## Ручная проверка

На **новой** MAX-группе с иконкой (бот — админ с `read_all_messages`):

1. Первое сообщение → в ОЛ новый чат: аватар = иконка группы, название = точное название. Первым идёт интро от «группы», за ним — сообщение автора.
2. Сверить через `imopenlines.dialog.get {USER_CODE: max_b24|<линия>|max:<chatId>|0}` → `name`, `avatar`.
3. Переименовать группу в MAX при открытой сессии → название чата ОЛ меняется. При закрытой — меняется после следующего сообщения группы, а следующую сессию открывает опенер, даже если Finish потерян (M27, [Group Session Opener](group-session-opener.md#ручная-проверка)).
4. Группа без иконки → аватар чата пустой.
5. Ответить оператором на интро → ответ уходит в MAX без цитаты-ссылки.
6. (M27) Сразу под интро — системное сообщение «MAXTOB24 / Ссылка на группу в MAX: https://max.ru/join/…». Ссылка кликабельна и ведёт в группу. В MAX-группу ничего не пришло. Следующие сообщения — без повтора.
7. (M27) Старая группа, подключённая до M27: первое сообщение после выката → после него одно системное сообщение со ссылкой. Второе сообщение и сообщение после рестарта api-node — без повтора.

БД:

```sql
SELECT max_chat_id, max_chat_title, ol_chat_title, b24_chat_id FROM chat_bindings ORDER BY id DESC LIMIT 5;
SELECT max_mid, payload_meta FROM message_log
 WHERE max_mid LIKE 'group-intro:%' OR max_mid LIKE 'chat_title_changed:%' ORDER BY id DESC LIMIT 10;
-- M27: ссылка на группу — по записи на каждую ссылку группы (via: intro | lazy | opener)
SELECT binding_id, payload_meta, created_at FROM message_log WHERE max_mid LIKE 'group-link:%' ORDER BY id DESC;
```

## Troubleshooting

| Симптом | Причина | Действие |
|---|---|---|
| Новый чат с фото и именем автора | Интро не ушло: WARN `no group title (or not a group chat)` или `group intro failed` | `GET /chats/{id}` упал или вернул пустой `title` / не `chat`; либо Б24 отклонил интро. Название всё равно поставит `chat.name.set`, аватар останется автора |
| Название чата не меняется после переименования в MAX | Нет события: подписка без `chat_title_changed` | `register-webhook --list` → нет типа → `--force` (на VPS) |
| INFO `OL session closed, chat title pending until next inbound` | Сессия ОЛ закрыта (`CHAT_RENAMING_FAILED`, поле 6 = `0`) | Норма: название применится на следующем сообщении группы |
| `pending` на каждом входящем: INFO `chat title pending (OL chat state unknown)` | `imopenlines.dialog.get` по `CHAT_ID` не отвечает — рядом WARN `b24.getOlChat: failed` | Смотреть `b24Code` (например, `ACCESS_ERROR`): права приложения на чат, существование чата `b24_chat_id` |
| `pending` на каждом входящем: INFO `rename failed with open session, chat title pending` | Сессия открыта, имя в ОЛ отличается от названия, а Б24 всё равно не переименовывает. Одинаковое имя сюда не попадает: оно даёт `synced` (`OL chat already has this title`) | Сверить `name` из `imopenlines.dialog.get {CHAT_ID: <b24_chat_id>}` с `max_chat_title`. «Числовые» названия, которые Б24 считает равными (`1e3` и `1000`), мост равными не считает |
| WARN `OL chat title sync failed` на каждом сообщении | `chat.name.set` падает не из-за `CHAT_RENAMING_FAILED` | Смотреть `b24Code`: права приложения, активность линии (`NOT_ACTIVE_LINE`), коннектор (`IMCONNECTOR_NO_CORRECT_PROVIDER`). С `step: 'arm-opener'` — не записался флаг опенера, см. [Group Session Opener](group-session-opener.md#troubleshooting) |
| Ссылки на группу нет в чате ОЛ | У группы нет ссылки (`hasLink: false` в DEBUG `maxService.getChatInfo`) или чат не группа; либо пост не удался: WARN `group link post failed` / `group link check failed` / `getChatInfo failed`; либо адрес чата ОЛ на момент поста был неизвестен: DEBUG `OL chat address unknown, group link not posted` | Проверить запись `group-link:` (SQL выше). Сбой повторится на следующем опенере или после рестарта api-node |
| Ссылка пришла ещё раз | MAX перевыпустил ссылку: новый хеш в ключе, `via: opener` | Норма: в чате актуальная ссылка, прежнее сообщение остаётся |
| Reply оператора на интро не дошёл | Ответ ушёл бы с битым `link` | Должен уходить без `link` (`resolvedVia: none`); проверить версию |

## See Also

- [Inbound Routing](inbound-routing.md) — авто-онбординг, имя автора в Б24
- [Membership Notifications](group-membership-notifications.md) — `b24_chat_id`, `imopenlines.dialog.get`, системные сообщения `im.message.add`
- [Group Session Opener](group-session-opener.md) — опенер сессии, второй сигнал закрытия по `CHAT_RENAMING_FAILED`
- [MAX Webhook Setup](max-webhook-setup.md) — подписка и `--force`
- [Webhooks](webhooks.md) — каркас `_once` и синтетические ключи
