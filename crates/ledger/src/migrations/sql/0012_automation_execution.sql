CREATE TABLE automation_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    document TEXT CHECK (document IS NULL OR json_valid(document))
) STRICT;
INSERT INTO automation_state(singleton, document) VALUES (1, NULL);

CREATE TABLE automation_claims (
    command_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL
) STRICT;
CREATE INDEX automation_claims_by_run ON automation_claims(run_id);

CREATE TRIGGER automation_owns_active_thread
BEFORE DELETE ON threads
WHEN EXISTS (
    SELECT 1 FROM automation_state,
        json_each(automation_state.document, '$.executions') AS execution
    WHERE json_extract(execution.value, '$.run.threadId') = OLD.id
)
BEGIN
    SELECT RAISE(ABORT, 'cancel and reconcile the automation before deleting its conversation');
END;
