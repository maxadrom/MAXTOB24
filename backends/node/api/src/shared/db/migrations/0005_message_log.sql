-- Журнал сообщений: единственная точка идемпотентности (через partial-unique
-- индексы по (binding_id, direction, max_mid|b24_msg_id)). Полное тело сообщения
-- НЕ кладём — только мета в payload_meta jsonb (chat_id, sender_id и т.п.).

CREATE TABLE message_log (
    id           bigserial PRIMARY KEY,
    binding_id   bigint NOT NULL REFERENCES chat_bindings(id) ON DELETE CASCADE,
    direction    text   NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    max_mid      text,
    b24_msg_id   text,
    status       text   NOT NULL DEFAULT 'received',
    error        text,
    payload_meta jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- Partial-unique только в Postgres-форме (отдельным CREATE UNIQUE INDEX),
-- inline UNIQUE ... WHERE внутри CREATE TABLE Postgres не поддерживает.
CREATE UNIQUE INDEX message_log_inbound_dedup_idx
    ON message_log (binding_id, direction, max_mid)
    WHERE max_mid IS NOT NULL;

CREATE UNIQUE INDEX message_log_outbound_dedup_idx
    ON message_log (binding_id, direction, b24_msg_id)
    WHERE b24_msg_id IS NOT NULL;

CREATE INDEX message_log_binding_created_idx
    ON message_log (binding_id, created_at DESC);
