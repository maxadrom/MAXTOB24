-- Маппинг участников MAX-чата на external user id внутри imconnector,
-- чтобы Open Lines различал авторов внутри одной групповой сессии.

CREATE TABLE participant_map (
    id                bigserial PRIMARY KEY,
    binding_id        bigint NOT NULL REFERENCES chat_bindings(id) ON DELETE CASCADE,
    max_user_id       text   NOT NULL,
    max_display_name  text,
    connector_user_id text,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX participant_map_binding_max_user_uniq_idx
    ON participant_map (binding_id, max_user_id);
