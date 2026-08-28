CREATE TABLE thread_projection (
    thread_id          TEXT    NOT NULL PRIMARY KEY,
    title              TEXT,
    busy               INTEGER NOT NULL CHECK (busy IN (0, 1)),
    last_seq           INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX thread_projection_recent
    ON thread_projection (updated_at_unix_ms DESC);
