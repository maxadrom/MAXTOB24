[← MAX Webhook Setup](max-webhook-setup.md) · [Назад к README](../../README.md) · [Outbound Routing →](outbound-routing.md)

# Backend — Inbound routing MAX → Open Lines

Runbook эксплуатации и ручной проверки inbound-маршрутизации: сообщение из
группового чата MAX доезжает до сессии Open Lines в Битрикс24 с правильным
автором. **M7:** первое сообщение из нового чата авто-создаёт привязку — никакого
ручного seed не требуется.

Цепочка кода (всё внутри [backends/node/api/](../../backends/node/api/)):

```
POST /webhook/max  (X-Max-Bot-Api-Secret)
  → maxController.handleWebhook        # MaxUpdate.fromWebhookBody, scoped-логгер с requestId
  → maxService.handleIncomingUpdate    # только группы: личка/канал → 200 skipped (M21)
  → messagingService.routeInbound      # ключ (mid | nomid:…) → resolve binding → [auto-onboard?] → dedup → ensureParticipant → [интро группы? → ссылка] → [опенер сессии? → ссылка?] → build → send → [сессия OL] → record → [название чата?] → [ссылка на группу?]
  → b24Service.sendConnectorMessage    # обогащает connectorId/lineId из installations, чек SUCCESS
  → b24Client.imconnectorSendMessages  # Verified schema M4.1, flattenParams → PHP-форма
```

Идемпотентность входящих — по `body.mid` через `message_log` (partial-unique
индекс на `(binding_id, direction, max_mid)`). Webhook MAX ретраится до 10× / 8ч,
поэтому dedup живёт в координаторе **до** вызова B24. Сообщение без `mid` получает
синтетический ключ — см. [Сообщение без mid](#сообщение-без-mid-m21).

## Scope (что делает / чего НЕ делает)

| Поддержано | Не поддержано (пост-MVP / другие milestone) |
|---|---|
| `message_created` с текстом | Outbound `OnImConnectorMessageAdd → MAX` (M5 — отдельный путь) |
| `message_edited` → правка в OL ([Message Editing](message-editing.md)) | Команда привязки из чата (не реализуется) |
| `message_removed` → удаление в OL ([Message Deletion](message-deletion.md)) | Авто-привязка сессии к Company в CRM (делается вручную оператором) |
| Группировка авторов в одну сессию (`CHAT_GROUP=true`) | Медиа-**правка** (правка вложения) — вне MVP |
| **Авто-онбординг: первое сообщение создаёт binding (M7)**, атомарно (M21) | Личка с ботом и каналы — [только группы](#только-группы-m21) |
| Название и иконка группы в чате ОЛ (M24) — [Group Title & Icon](group-title-icon.md) | Смена иконки группы после создания чата |
| Группа — «Клиент» каждой сессии ОЛ: опенер после закрытия диалога (M25) — [Group Session Opener](group-session-opener.md) | Сессии, закрытые до выката M25 |
| Ссылка на MAX-группу системным сообщением в чате ОЛ (M27) — [Group Title & Icon](group-title-icon.md#ссылка-на-группу-m27) | Отзыв ссылки: прежнее сообщение в чате остаётся |
| Dedup по `mid`, retry-safe | |
| Медиа-вложения (фото/видео/документы/стикеры/голос) — [Media Transfer](media-transfer.md) | |
| Изоляция нескольких групп (разные `chat.id` → разные сессии OL) | |

## Авто-онбординг (M7): как это работает

```
1. Добавить бота в MAX-группу → дать ему права админа (read_all_messages).
2. Написать первое сообщение в группе.
3. routeInbound получает webhook message_created:
   - resolveByMaxChat → нет записи в chat_bindings → вызывает ensureForMaxChat(chatId)
   - ensureForMaxChat: один upsert — INSERT … (connector_chat_id = 'max:<chatId>')
     ON CONFLICT (installation_id, max_chat_id) DO UPDATE (M21)
   - binding.isReadyForRouting() === true → маршрутизация продолжается
4. Чат OL ещё неизвестен (b24_chat_id пуст) → интро от «группы» (M24):
   GET /chats/{id} → send.messages от group:<chatId> с иконкой группы
   → im.message.add SYSTEM=Y: «Ссылка на группу в MAX: …» (M27, если у группы есть ссылка)
5. Сообщение автора → сессия в Open Lines (`OL_LINE_ID`) с chatId = max:<chatId>.
6. После записи в message_log — imconnector.chat.name.set: точное название группы.
7. Группе, подключённой до M27, ссылка уходит здесь же, один раз — на первом сообщении
   после выката (ленивый шаг: SELECT по message_log, при отсутствии записи — GET /chats).
8. CRM-привязка к контакту/компании — оператор делает вручную в Б24 (нативный интерфейс OL).
```

Без интро Б24 назвал бы чат «<имя автора> - <линия>» и поставил аватаром фото автора:
`chat.name` из `send.messages` он не читает. Подробно — [Group Title & Icon](group-title-icon.md).

Следующие сессии того же чата открывает опенер «Новое обращение из группы «…» в MAX»:
после `OnImConnectorDialogFinish` он уходит перед первым сообщением новой сессии, и её
клиентом тоже становится группа. Подробно — [Group Session Opener](group-session-opener.md).
С M27 флаг опенера взводит и переименование группы при закрытом диалоге (ответ
`CHAT_RENAMING_FAILED` + `imopenlines.dialog.get`) — на случай, если Finish потерян. Если MAX
перевыпустил ссылку на группу, после опенера уходит системное сообщение с новой ссылкой.

Шаги после записи (название чата, ссылка на группу) — best-effort: доставку они не
задерживают (только ответ вебхука), а их сбой не меняет ответ 200.

Ключевой лог при авто-онбординге:
```
DEBUG routeInbound: no ready binding, auto-onboarding  chatId: <MAX_CHAT_ID>, repairing: false
INFO  auto-onboarded <MAX_CHAT_ID> → binding <id>         bindingId: <id>
INFO  auto-onboarded binding <id> connector_chat_id=max:<MAX_CHAT_ID>
```

**Атомарность (M21).** До M21 привязка создавалась двумя запросами: INSERT и отдельный
UPDATE `connector_chat_id`. Сбой между ними оставлял привязку без `connector_chat_id`, и
все сообщения чата навсегда скипались как `binding-not-ready`; второе из двух почти
одновременных первых сообщений получало 500 или терялось. Теперь:

- привязка создаётся одним upsert'ом, гонка первых сообщений получает одну строку, оба
  сообщения доходят, интро уходит один раз (`_serialized` + `_once('group-intro:…')`);
- привязка без `connector_chat_id` чинится на следующем входящем тем же upsert'ом
  (WARN `binding without connector chat repaired`);
- миграция `0012` дозаполнила такие привязки и сделала колонку `NOT NULL`.

**После удаления приложения Б24 (M26)** онбординг закрыт: `ensureForMaxChat` видит
`installations.uninstalled_at` и бросает `ConfigError` → `503 CONFIG_ERROR`, привязка не
создаётся, MAX ретраит. Открывает его только переустановка — [App Installation](app-installation.md#переустановка).

## Только группы (M21)

Мост связывает **группы** MAX с ОЛ. `maxService` смотрит `message.recipient.chat_type`
до координатора (`MaxUpdate.isGroupChat()`):

| `chat_type` | Что происходит |
|---|---|
| `chat` (группа) | Обычный путь |
| нет поля | Как группа (fail-open: так мост работал до M21) |
| `dialog` (личка с ботом) | 200 `{ skipped: 'not-group-chat' }`, привязки нет. Автору — одна подсказка «Я работаю только в группах: добавьте меня в группу MAX и выдайте права администратора…» (`POST /messages?user_id=`; дедуп в памяти процесса, после рестарта уйдёт ещё раз). Правка в личке — молча |
| `channel` и любое другое | 200 `{ skipped: 'not-group-chat' }` молча: ответ в канале стал бы постом |

`message_removed` не несёт `chat_type`; в чате без привязки удаление и так скипается.

Лог: `INFO max update from non-group chat, skipping  chatId, chatType, senderId`, затем
`INFO dialog hint sent` (или WARN `dialog hint send failed` — вебхук всё равно 200).

### Аудит привязок, созданных до M21

До M21 лички и каналы онбордились как группы: личка — с полноценной сессией ОЛ у
операторов, канал — привязкой без сообщений. Тип чата знает только MAX API, поэтому
миграцией их не вычистить. Read-only скрипт:

```bash
make audit-bindings              # таблица: id, max_chat_id, тип из GET /chats/{id}, вердикт, счётчики
make audit-bindings ARGS="--json"
```

Вердикты: `group` — норма; `not-group` — личка или канал, кандидат на удаление;
`unknown` — MAX не ответил (бот удалён из чата или чат удалён), проверить вручную.
Скрипт ничего не меняет. Для кандидатов он печатает
`DELETE FROM chat_bindings WHERE id IN (…)`: выполнять **вручную и только с согласия
владельца прода**. Каскад удаляет `message_log` и `participant_map` привязки; открытые
сессии ОЛ этих чатов закрыть в Б24 руками.

## Сообщение без mid (M21)

По доке MAX у пересылки без своего текста `body` может быть null, и тогда `mid` нет. Живая
пересылка из группы (2026-10-08) пришла со своим `mid` и пустым `body.text`, так что ключ
ниже — страховка на случай такого payload. Сообщение без `mid` получает ключ `nomid:<chatId>:<senderId>:<timestamp>` (timestamp стабилен на ретраях
одного события) и external id `max:nomid:…`. Ретрай MAX → `duplicate`. Ограничения:

- ответ оператора на такое сообщение уходит в MAX без нативного reply (`link`): mid
  родителя неизвестен ([Reply Quoting](reply-quoting.md));
- правка и удаление его в ОЛ не применятся: в их событиях будет уже настоящий `mid`.

Нет ни `mid`, ни `timestamp` → 200 `{ skipped: 'no-mid' }` до онбординга: без ключа
ретраи дублировали бы сообщение.

## Имя автора в Б24

Каждый автор MAX — отдельный пользователь коннектора в Б24 (`user.id` = MAX `user_id`). Имя: `sender.name` → `first_name last_name` → `MAX user <id>` (`MaxUpdate.deriveSenderName`), `last_name` всегда пустой.

Б24 переписывает имя пользователя коннектора на **каждом** `imconnector.send/update/delete.messages`; пустое имя → «Гость». Поле NAME ограничено (live-проба 2026-10-07): не больше 50 символов, а на первом символе вне BMP (🚀, 🌸, флаги — 4 байта в UTF-8) имя обрывается. Поэтому `b24Service` перед отправкой прогоняет имя через `b24/connectorUserName.js`:

- символы вне BMP вырезаются вместе с прилегающими ZWJ/VS16 («Аня 🌸 Петрова» → «Аня Петрова»); BMP-символы (❤️ ☕), кавычки и HTML остаются;
- пробелы схлопываются, длиннее 50 → 49 символов + «…»;
- пусто после чистки → `MAX user <id>`.

В БД (`participant_map.max_display_name`) хранится исходное имя из MAX: санитизация — только на границе с Б24. Удаление тоже шлёт имя — см. [Message Deletion](message-deletion.md).

## Prerequisites

1. На портале `$B24_PORTAL` **установлено приложение** — в `installations` непустой
   `b24_access_token` (пишет `POST /api/install`).
2. Коннектор `$B24_CONNECTOR_ID` зарегистрирован и активирован на `$OL_LINE_ID`
   (см. [connector-registration.md](connector-registration.md)).
3. MAX webhook подписан на `message_created` (см. [max-webhook-setup.md](max-webhook-setup.md)).
4. MAX-бот **добавлен в группу** и имеет права **админа** (`read_all_messages`) —
   иначе MAX не шлёт сообщения боту.

> **M7:** ручной seed больше не требуется. Binding создаётся автоматически
> при первом входящем сообщении.

## Команды развёртывания

```bash
# Последовательность (idempotent — повтор безопасен):
make register-connector          # M2: регистрация + активация коннектора на OL
make register-webhook            # M3: подписка MAX webhook на message_created
# Ручной seed удалён в M7; привязка создаётся авто при первом сообщении.
```

## Ручная проверка acceptance (M7)

### Группа A (первый онбординг)

1. Поднять стек: `make dev-node`, дождаться `INFO server listening  port: 8000`.
2. Добавить бота в MAX-группу A, дать права **admin** (`read_all_messages`).
3. Написать первое сообщение от любого участника.
4. В логах backend (`make logs`) ожидаем:

   ```
   INFO max webhook received                 updateType: message_created, chatId: <A>, mid: ...
   DEBUG routeInbound: no binding for max chat, auto-onboarding   chatId: <A>
   INFO  auto-onboarded <A> → binding <id>
   DEBUG routeInbound: ensureParticipant
   INFO  b24 imconnector.send.messages        connectorId: max_b24, lineId: 42, count: 1
   INFO  routeInbound: delivered to Open Line  b24MsgId, sessionId, durationMs
   ```

5. В OL 42 появилась **новая сессия** с `chat.id = max:<A>` и корректным автором.

### Группа B (изоляция)

6. Добавить бота в MAX-группу **B** (другой чат) с правами admin, написать сообщение.
7. В OL 42 появляется **отдельная вторая сессия** с `chat.id = max:<B>`. Сессии A и B не схлопнулись.

### Один автор в двух группах

8. Один и тот же человек пишет в A и в B.
9. Он виден в **обеих** сессиях как отдельный участник (ключ изоляции — `chat.id`, не `user.id`).

### Дубль-проверка (идемпотентность)

Повтор того же webhook (или ретрай MAX с тем же `body.mid`) **не** создаёт второй
записи и **не** дёргает `imconnector.send.messages` повторно:

```
WARN routeInbound: duplicate, skipping   bindingId, key (= mid), logId
```

### Проверка в БД

```bash
docker compose exec -T database-postgres psql -U appuser -d appdb \
  -c "SELECT id, max_chat_id, connector_chat_id FROM chat_bindings ORDER BY id DESC LIMIT 5;"
# Ожидаем: connector_chat_id = 'max:<chatId>'

docker compose exec -T database-postgres psql -U appuser -d appdb \
  -c "SELECT id, binding_id, direction, max_mid FROM message_log WHERE direction='inbound' ORDER BY id DESC LIMIT 5;"
```

> ⚠️ Текст сообщения **не** логируется целиком (PII) — только префикс ≤32 символов
> на уровне `debug`. Токены (`MAX_BOT_TOKEN`, `b24_access_token`) не логируются никогда.

## Troubleshooting

Все skip-вердикты `routeInbound` отдают контроллеру **200 OK** (MAX не ретраит).
5xx бросаем только на реальной ошибке B24 — тогда ретрай MAX уместен.

| Симптом в логах | Причина | Действие |
|---|---|---|
| `warn ... binding without connector chat repaired` | Привязка без `connector_chat_id` (сбой онбординга до M21) починена upsert'ом | Норма, разовая. Сообщение доставлено |
| `info ... max update from non-group chat, skipping` (`skipped:'not-group-chat'`) | Личка с ботом или пост канала | Норма (M21). Старые привязки таких чатов — `make audit-bindings` |
| `warn ... message without mid and timestamp` (`skipped:'no-mid'`) | Нет ни `body.mid`, ни `timestamp` — ключ дедупа не построить | Не должно появляться; снять сырой payload (`LOG_LEVEL=debug`) |
| `warn ... message_created without sender` (`skipped:'no-sender'`) | Системное `message_created` без `sender.user_id` | Норма — такие не маршрутизируем (иначе 500-цикл). |
| `warn ... empty message` / `media not supported` (`skipped:'empty-message'`) | Нет текста (или только вложения) | Норма для M4 — медиа пост-MVP. |
| `B24ApiError ... SUCCESS=false` (`CONNECTOR_SEND_FAILED`) | B24 вернул `RESULT[0].SUCCESS=false` | Коннектор деактивирован / линия удалена / payload отклонён. Проверить `make register-connector` и линию в админке OL. |
| `error ... B24 send failed` → HTTP 500 | 5xx/`expired_token`/network от B24 | `recordInbound` НЕ пишется, MAX ретраит. При `expired_token` — переустановить приложение. |
| Клиент в OL — «Гость» или имя оборвано | Б24 переписывает имя на каждом вызове; до M23 так делал delete без имени, а эмодзи вне BMP обрывали имя | После M23 не должно появляться; старые «Гости» вылечатся на следующем сообщении автора. См. [Имя автора в Б24](#имя-автора-в-б24). |
| Новый чат OL назван по автору, с его фото | Интро группы не ушло (WARN `group intro failed` / `no group title`) | См. [Group Title & Icon → Troubleshooting](group-title-icon.md#troubleshooting) |
| Клиент второй и следующих сессий — человек, а не группа | Опенер не ушёл: Finish не дошёл (INFO `OL session changed without DialogFinish`) или WARN `group session opener failed` | См. [Group Session Opener → Troubleshooting](group-session-opener.md#troubleshooting) |
| Нет ссылки на группу в чате OL; WARN `group link post failed` / `group link check failed` | Нет ссылки у группы, или `GET /chats` / `im.message.add` / SELECT упали (best-effort, сообщение доставлено) | См. [Group Title & Icon → Troubleshooting](group-title-icon.md#troubleshooting) |
| `request failed` `503 CONFIG_ERROR` `ensureForMaxChat: Bitrix24 app is uninstalled` | Приложение Б24 удалено (`ONAPPUNINSTALL`, M26): онбординг закрыт, привязка не создаётся; старая привязка (`CLEAN=0`) даёт `502 B24_NO_AUTH` | MAX ретраит до 10× за 8 ч. Переустановить приложение — [App Installation](app-installation.md#переустановка) |
| Сессия в OL не появляется, авто-онбординг не сработал | Бот не имеет прав `read_all_messages` в группе | MAX не шлёт webhook'и для чатов без прав. Проверить через M6a-лог (`bot_added` с `isChannel`). |

## См. также

- [connector-registration.md](connector-registration.md) — M2: регистрация коннектора (prerequisite).
- [max-webhook-setup.md](max-webhook-setup.md) — M3: подписка MAX webhook (prerequisite).
- [webhooks.md](webhooks.md) — паттерн webhook-проверки и ответов (idempotency).
- [reply-quoting.md](reply-quoting.md) — `>>`-цитата MAX→OL, встраиваемая в `routeInbound` до empty-guard.
- [group-title-icon.md](group-title-icon.md) — интро группы и название чата OL (M24), ссылка на группу (M27).
- [group-session-opener.md](group-session-opener.md) — «группа» открывает каждую сессию OL (M25), второй сигнал закрытия (M27).
- [architecture.md](architecture.md) — координатор `messagingService`, где живёт идемпотентность.
