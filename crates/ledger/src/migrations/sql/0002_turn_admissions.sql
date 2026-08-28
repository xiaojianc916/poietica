CREATE TABLE turn_admissions (
    turn_id              TEXT    NOT NULL PRIMARY KEY,
    thread_id            TEXT    NOT NULL,
    prompt               TEXT    NOT NULL,
    model                TEXT    NOT NULL,
    attachments          TEXT    NOT NULL,
    submitted_at_unix_ms INTEGER NOT NULL,
    admitted_at_unix_ms  INTEGER NOT NULL
) STRICT;

CREATE INDEX turn_admissions_by_thread
    ON turn_admissions (thread_id, admitted_at_unix_ms);
