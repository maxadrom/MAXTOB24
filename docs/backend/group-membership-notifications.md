[← Media Transfer](media-transfer.md) · [Назад к README](../../README.md) · [Group Title & Icon →](group-title-icon.md)

# Уведомления о вступлении/выходе участников группы

При `user_added`/`user_removed` в подключённой MAX-группе оператору в OL-чате Битрикс24 показывается **системное** («скрытое») сообщение о том, что участник вступил или покинул группу. Уведомление не открывает/реанимирует OL-сессию, не уходит клиентам в MAX и не выглядит как сообщение клиента.

## Поток

```
MAX webhook (user_added/user_removed)
  → maxController → maxService.handleLifecycleEvent
    → _routeLifecycleSafe (никогда не бросает наружу → вебхук 200)
      → messagingService.routeLifecycle
        → bindingsService.resolveByMaxChat       (нужен binding.b24ChatId)
        → messageLogRepository.findInbound        (дедуп по синтетическому ключу)
        → b24Service.sendSystemMessage
          → b24Client.imMessageAdd                (im.message.add, SYSTEM='Y')
        → messageLogRepository.recordInbound
```

Адаптер `max/` **не** зовёт `b24/` напрямую — отправка и идемпотентность живут в координаторе `messaging/` и адаптере `b24/` (см. [Architecture](architecture.md)).

## Тексты уведомлений

| Событие | Текст (BB-код) |
|---|---|
| `user_added` | `👋 Новое вступление в группу [b]<Имя Фамилия>[/b]` |
| `user_removed` | `🚪 Участник покинул группу [b]<Имя Фамилия>[/b]` |

Имя берётся из `payload.user`: `first_name` + `last_name` (trim), fallback на устаревший `name`, финальный fallback — `MAX user <userId>`. Имя задаёт пользователь MAX, поэтому BB-теги в нём экранируются (`escapeBbcode`) — `[url=…]` в имени не станет ссылкой в чате оператора. Б24 дописывает имя приложения (`[b]MAXTOB24[/b]`) сверху сам — второй раз его не добавляем.

## Целевой метод B24

`im.message.add` (scope `im`, сверено через docs MCP 2026-06-10):

| Параметр | Значение |
|---|---|
| `DIALOG_ID` | `chat<b24ChatId>` |
| `MESSAGE` | текст уведомления (с BB-кодами) |
| `SYSTEM` | `'Y'` — системное сообщение (пузырь со стороны портала) |
| `URL_PREVIEW` | `'N'` — не разворачиваем ссылки в косметике |

Owner-токен приложения имеет доступ к OL-чату; метод возвращает `result` (id сообщения) напрямую, без `SUCCESS`-конверта.

## Адрес OL-чата (`b24_chat_id`)

`im.message.add` адресуется по `DIALOG_ID = 'chat' + <CHAT_ID>`. Этот `CHAT_ID` стабилен между сессиями одной группы (проверено live), поэтому персистится на binding'е:

- **Миграция:** `0007_add_b24_chat_id_to_chat_bindings` — `chat_bindings.b24_chat_id text` (nullable).
- **Заполнение:** best-effort на каждом inbound из `session.CHAT_ID` ответа `imconnector.send.messages` (лишний `UPDATE` при неизменном значении не делается). Ошибка персиста не валит доставку основного сообщения.
- **Graceful skip:** если lifecycle пришёл **до** первого сообщения (адрес ещё не заполнен) — уведомление пропускается (`{ skipped: 'no-binding-or-chat' }`).

## Идемпотентность

У lifecycle нет `mid`, поэтому используется синтетический ключ:

```
<event>:<chatId>:<userId>:<timestamp>
```

Ключ пишется в существующий `message_log` (`direction='inbound'`, `payload_meta.kind='lifecycle'`) и переиспользует partial-unique индекс `(binding_id, direction, max_mid)`. `timestamp` берётся из `payload.timestamp` (одинаков при ретраях MAX того же события), **не** `Date.now()` — поэтому ретрай не плодит дубль, а «вышел → зашёл» (разные timestamps) даёт два корректных уведомления.

## Best-effort (никогда не 5xx)

Lifecycle — косметика; ошибка не должна заставлять MAX ретраить.

| Сбой | Поведение |
|---|---|
| Нет binding / `b24_chat_id` | `{ skipped: 'no-binding-or-chat' }` |
| Дубль события | `{ skipped: 'duplicate' }` |
| Ошибка `sendSystemMessage` | ERROR-лог → `{ skipped: 'send-failed' }` |
| Гонка `recordInbound` | `{ skipped: 'duplicate-race' }` |
| Любое исключение координатора | `_routeLifecycleSafe` ловит → `{ ok: true, skipped: 'lifecycle-error' }` |

Во всех случаях `/webhook/max` отдаёт 200.

## Скоуп веток `handleLifecycleEvent`

| Событие | Поведение |
|---|---|
| `user_added`, чужой (`senderId !== botId`) | → `routeLifecycle` (уведомление о вступлении) |
| `user_added`, self (`senderId === botId`) | проверка admin-прав (M6a), **не** уведомление |
| `user_removed` | → `routeLifecycle` (уведомление о выходе) |
| `bot_added` / `bot_removed` | M6a admin-права / очистка dedup-guard (без изменений) |
| `* + is_channel:true` | `skip-channel` |

> ⚠️ **Прод-предостережение:** в проде есть живые не-тестовые группы. Live-пробы — только в тест-группы.

## Ключевые файлы

| Файл | Роль |
|---|---|
| `src/shared/db/migrations/0007_add_b24_chat_id_to_chat_bindings.sql` | колонка `b24_chat_id` |
| `src/modules/bindings/models/ChatBinding.js` | `b24ChatId` |
| `src/modules/bindings/bindingsService.js` | `attachB24ChatId` (фасад) |
| `src/modules/messaging/messagingService.js` | `routeLifecycle`, персист `b24_chat_id` на inbound |
| `src/modules/b24/b24Service.js` | `sendSystemMessage` |
| `src/modules/b24/b24Client.js` | `imMessageAdd` (`im.message.add`) |
| `src/modules/max/maxService.js` | ветки `user_added`/`user_removed`, `_routeLifecycleSafe` |
| `src/modules/max/models/MaxUpdate.js` | имя участника для lifecycle (`deriveLifecycleName`) |
| `tests/messaging/messagingService.test.js` | `routeLifecycle` (8 кейсов) |
| `tests/max/maxService.lifecycle.test.js` | маршрутизация веток (5 кейсов) |
| `tests/b24/b24Client.test.js`, `tests/b24/b24Service.test.js` | `imMessageAdd` / `sendSystemMessage` |
| `tests/max/MaxUpdate.test.js` | извлечение имени из lifecycle |

## Troubleshooting

**Уведомление не появляется в OL-чате:**
1. DEBUG-лог `routeLifecycle: no binding or b24ChatId yet` — в группу ещё не было ни одного клиентского сообщения (адрес OL-чата не персистнут). Отправьте сообщение в группу, затем повторите вступление/выход.
2. ERROR-лог `system message send failed` — проверьте scope `im` у токена приложения и доступ к OL-чату.

**Дубли уведомлений:**
- Ключ дедупа включает `payload.timestamp`. Если MAX прислал событие с другим timestamp — это считается новым событием (корректно для «вышел → зашёл»).

**Имя отображается как «MAX user <id>»:**
- В `payload.user` не было ни `first_name`/`last_name`, ни `name` — сработал финальный fallback.

## See Also

- [Inbound Routing](inbound-routing.md) — MAX → Open Lines, где персистится `b24_chat_id`
- [Admin Health-check](admin-healthcheck.md) — соседние ветки `handleLifecycleEvent`
- [Architecture](architecture.md) — направление зависимостей адаптер → координатор → адаптер
