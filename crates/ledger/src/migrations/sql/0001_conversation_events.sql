CREATE TABLE conversation_events (
    thread_id          TEXT    NOT NULL,
    seq                INTEGER NOT NULL,
    turn_id            TEXT,
    kind               TEXT    NOT NULL,
    payload            TEXT    NOT NULL,
    recorded_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (thread_id, seq)
) STRICT;

CREATE INDEX conversation_events_by_turn
    ON conversation_events (thread_id, turn_id, seq);
