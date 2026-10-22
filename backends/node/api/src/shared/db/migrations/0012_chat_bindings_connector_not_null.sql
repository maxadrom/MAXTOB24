-- connector_chat_id обязателен (M21). До M21 онбординг шёл двумя запросами: INSERT
-- привязки и отдельный UPDATE connector_chat_id. Сбой между ними оставлял привязку
-- без connector_chat_id, и все сообщения чата навсегда скипались как binding-not-ready.
-- Теперь привязка создаётся одним upsert'ом сразу с connector_chat_id = 'max:<chatId>'
-- (формат не менялся с M7). Бэкфилл оживляет такие чаты, NOT NULL закрепляет инвариант.
-- Деплой поднимает код раньше миграции: новый upsert работает и без NOT NULL.

UPDATE chat_bindings
   SET connector_chat_id = 'max:' || max_chat_id, updated_at = now()
 WHERE connector_chat_id IS NULL;

ALTER TABLE chat_bindings ALTER COLUMN connector_chat_id SET NOT NULL;
