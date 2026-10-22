-- Название, которое коннектор последним поставил в чат Open Lines через
-- imconnector.chat.name.set (M24). Б24 игнорирует chat.name в send.messages и
-- ставит заголовок по шаблону «<клиент> - <линия>», поэтому точное название
-- MAX-группы применяем отдельным вызовом. Метод работает только при открытой
-- сессии: max_chat_title (название в MAX) расходится с ol_chat_title, пока
-- переименование не прошло, и применяется на следующем входящем.
-- Бэкфилл: существующие чаты считаем синхронизированными — их названия ставил
-- оператор вручную, M24 их не трогает.
-- Деплой поднимает код раньше миграции: ChatBinding.fromRow без этой колонки
-- тоже считает чат синхронизированным.

ALTER TABLE chat_bindings ADD COLUMN IF NOT EXISTS ol_chat_title text;

UPDATE chat_bindings SET ol_chat_title = max_chat_title WHERE ol_chat_title IS NULL;
