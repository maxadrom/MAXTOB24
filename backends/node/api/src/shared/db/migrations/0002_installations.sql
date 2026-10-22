-- Таблица установок приложения Б24. На MVP single-tenant — будет одна запись,
-- но id готов к multi-tenant.

CREATE TABLE installations (
    id              bigserial PRIMARY KEY,
    b24_portal      text        NOT NULL,
    b24_access_token       text,
    b24_refresh_token      text,
    b24_application_token  text,
    ol_line_id      integer,
    connector_id    text,
    max_bot_id      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX installations_b24_portal_uniq_idx
    ON installations (b24_portal);
