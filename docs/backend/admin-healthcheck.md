[← Formatting + Delivery](formatting-delivery.md) · [Назад к README](../../README.md) · [Media Transfer →](media-transfer.md)

# Health-check admin-прав MAX-бота

Проверяет наличие `read_all_messages` у бота в момент онбординга в группу и отправляет предупреждение в чат, если права отсутствуют. Без этого разрешения бот видит только @упоминания и ответы — клиентские сообщения молча не доходят до Open Lines.

## Что проверяет и когда

| Триггер | Условие запуска |
|---|---|
| `bot_added` | `is_channel !== true` + `chatId !== null` + токен присутствует |
| `user_added(self)` | те же условия + `update.senderId === botId` (добавленный участник — сам бот) |
| `bot_removed` | очищает dedup-guard для chatId (повторное добавление снова предупредит) |

**Каналы (is_channel: true):** проверка не запускается.

## Решающий признак прав

`permissions.includes('read_all_messages')` — единственный критерий.  
`is_admin` остаётся в логах как контекст, на решение не влияет.

## Текст предупреждения

> Чтобы я пересылал сообщения этой группы в Битрикс24, выдайте мне права администратора (доступ ко всем сообщениям). Без этого я вижу только упоминания и ответы.

Сообщение отправляется через `maxClient.sendMessage({ chatId, text })`.

## Dedup-guard

In-memory `Set<String>` (ключ — `String(chatId)`).

- Перед отправкой: если chatId уже в Set → DEBUG «already sent, skip» → не отправляем.
- После успешной отправки: добавляем в Set.
- `sendMessage` бросает: chatId **не** добавляется в Set (повторная попытка при следующем событии).
- `bot_removed`: удаляем из Set.

**Следствие:** двойной `bot_added`+`user_added(self)` на одном онбординге даёт РОВНО одно предупреждение.

## Гарантия «никогда 5xx»

`handleLifecycleEvent` оборачивает логику во внешний try/catch и **всегда** возвращает `{ ok: true, lifecycle: updateType }`. MAX не получает 5xx и не уходит в ретрай-шторм.

| Сбой | Поведение |
|---|---|
| `getChatMember` бросает | WARN-лог, `ok: null` → предупреждение не отправляется |
| `getMe` бросает (botId) | WARN-лог, `botId = null` → `user_added` self-check пропускается |
| `sendMessage` бросает | WARN-лог, chatId **не** попадает в guard (retry возможен) |

## botId — ленивая мемоизация

`MaxService._getBotId()` вызывает `getMe()` только при первом обращении, далее возвращает кэш.  
In-flight promise предотвращает параллельные `getMe` при одновременных событиях.  
Сбой `getMe` **не кэшируется** — следующее событие повторит попытку.

## Live-acceptance чек-лист

Портал: `example.bitrix24.ru` / тестовая MAX-группа.

- [ ] Бот добавлен в группу **без** admin/`read_all_messages` → в чат прилетает РОВНО одно предупреждение + WARN-лог; повторный `user_added(self)`/реплей не плодит второе.
- [ ] Бот **с правами** (`read_all_messages` присутствует) → тихо, только INFO-лог, ни одного сообщения в чат.
- [ ] Добавление бота в **канал** (`is_channel:true`) → проверка не запускается, предупреждения нет.
- [ ] Любой сбой (`getChatMember`/`getMe`/`sendMessage`) → **нет** 5xx на `/webhook/max`.

### Известные ограничения

Не проверено live:
- доставляется ли `sendMessage` бота в группу без `read_all_messages` (если нет — предупреждение не дойдёт, останется только WARN-лог);
- шлёт ли MAX на одном онбординге оба события — `bot_added` и `user_added(self)`. Мост готов к обоим: предупреждение уходит один раз.

## Ключевые файлы

| Файл | Роль |
|---|---|
| `backends/node/api/src/modules/max/maxService.js` | `handleLifecycleEvent`, `_checkBotPermissions`, `_getBotId`, `_maybeWarn` |
| `backends/node/api/src/modules/max/models/MaxUpdate.js` | `isChannel` поле DTO |
| `backends/node/api/src/modules/max/maxController.js` | scoped-логгер для lifecycle |
| `backends/node/api/tests/max/maxService.lifecycle.test.js` | 12 unit-кейсов |
| `backends/node/api/tests/max/MaxUpdate.test.js` | is_channel нормализация (кейсы 8-12) |

## Troubleshooting

**Предупреждение не отправляется:**
1. Проверить WARN-лог `sendMessage failed` — возможно, у бота нет прав на отправку.
2. Проверить `is_channel` в raw payload — канал пропускается.
3. Проверить `botId` в логах — при `getMe` сбое `user_added(self)` пропускается.

**Двойные предупреждения:**
- Dedup-guard in-memory — после рестарта контейнера Set очищается. При hot-restart между двумя событиями онбординга возможно второе сообщение.

**Изменение env:**
```
docker compose --profile node up -d --force-recreate api-node
```
(не `restart` — не перечитывает `env_file`).

## См. также

- [Inbound Routing](inbound-routing.md) — путь MAX → Open Lines, в который встроена проверка
- [Formatting + Delivery](formatting-delivery.md) — отправка предупреждения оператору
- [MAX Webhook Setup](max-webhook-setup.md) — подписка на события группы
