-- Удаление наследия PHP-стартера: infrastructure/database/init.sql создавал на пустом
-- томе Postgres Doctrine-таблицы bitrix24account и application_installation и
-- расширение uuid-ossp. Коннектор их не читает и не пишет (свои токены — в
-- installations), монтирование init.sql снято в M20.
-- Порядок: application_installation держит FK на bitrix24account. Без CASCADE:
-- неожиданная зависимость уронит миграцию в транзакции раннера, а не снесёт лишнее.
-- Перед деплоем на проде таблицы проверены на пустоту (count(*) = 0).
-- На БД без init.sql (тестовая, новые установки) — no-op благодаря IF EXISTS.

DROP TABLE IF EXISTS application_installation;
DROP TABLE IF EXISTS bitrix24account;
DROP EXTENSION IF EXISTS "uuid-ossp";
