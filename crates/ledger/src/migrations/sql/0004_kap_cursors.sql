CREATE TABLE kap_cursors (
    thread_id          TEXT    NOT NULL PRIMARY KEY,
    token              TEXT,
    committed_seq      INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
) STRICT;
