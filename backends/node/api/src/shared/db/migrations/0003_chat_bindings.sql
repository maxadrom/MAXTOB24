-- Маппинг MAX-чата на сессию Open Lines и Company в CRM Б24.
-- company_id и connector_chat_id nullable: заполняются на M4+ после первого сообщения.

CREATE TABLE chat_bindings (
    id                bigserial PRIMARY KEY,
    installation_id   bigint  NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
    max_chat_id       text    NOT NULL,
    max_chat_title    text,
    company_id        integer,
    connector_chat_id text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX chat_bindings_installation_max_chat_uniq_idx
    ON chat_bindings (installation_id, max_chat_id);

CREATE INDEX chat_bindings_connector_chat_idx
    ON chat_bindings (installation_id, connector_chat_id);
