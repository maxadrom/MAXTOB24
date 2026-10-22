-- Bootstrap-миграция: создаёт таблицу для журнала применённых миграций.
-- Должна быть первой по алфавиту (0001_*), идемпотентна.

CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
