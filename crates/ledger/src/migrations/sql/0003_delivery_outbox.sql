CREATE TABLE delivery_outbox (
    turn_id            TEXT    NOT NULL PRIMARY KEY
        REFERENCES turn_admissions (turn_id) ON DELETE CASCADE,
    thread_id          TEXT    NOT NULL,
    state              TEXT    NOT NULL
        CHECK (state IN ('pending', 'sent', 'accepted', 'unknown', 'failed')),
    attempts           INTEGER NOT NULL DEFAULT 0,
    updated_at_unix_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX delivery_outbox_unresolved
    ON delivery_outbox (state, updated_at_unix_ms);
