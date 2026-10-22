-- Удаление колонки company_id из chat_bindings.
-- Колонка всегда NULL и не участвует в маршрутизации с M7 (isReadyForRouting
-- проверяет только connector_chat_id). Привязка к Company в CRM делается
-- оператором вручную в нативном UI Open Lines, а не этим коннектором.
-- Безопасно применять на проде: данные в колонке отсутствуют.

ALTER TABLE chat_bindings DROP COLUMN IF EXISTS company_id;
