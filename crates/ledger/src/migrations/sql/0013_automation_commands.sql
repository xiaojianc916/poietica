ALTER TABLE automation_claims ADD COLUMN request_id TEXT;
UPDATE automation_claims
SET request_id = substr(command_key, -36)
WHERE command_key LIKE 'manual:%';

CREATE INDEX automation_claims_by_request
ON automation_claims(request_id) WHERE request_id IS NOT NULL;

-- Historical rows are retained even if an earlier writer reused an identity.
CREATE TRIGGER automation_request_identity
BEFORE INSERT ON automation_claims
WHEN NEW.request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM automation_claims
    WHERE request_id = NEW.request_id OR run_id = NEW.request_id
)
BEGIN
    SELECT RAISE(ABORT, 'automation request identity is already owned');
END;

-- Admission and cancellation are ordered by the same SQLite writer transaction.
CREATE TRIGGER automation_admission_ownership
BEFORE INSERT ON turn_admissions
WHEN EXISTS (
    SELECT 1 FROM automation_state AS s, json_each(s.document, '$.executions') AS e
    WHERE json_extract(e.value, '$.run.threadId') = NEW.thread_id
      AND (
        json_extract(e.value, '$.run.id') != NEW.turn_id
        OR json_extract(e.value, '$.cancelRequested') = 1
        OR json_extract(e.value, '$.run.outcome') != 'dispatching'
      )
) OR (
    EXISTS (SELECT 1 FROM automation_claims WHERE run_id = NEW.turn_id)
    AND NOT EXISTS (
        SELECT 1 FROM automation_state AS s, json_each(s.document, '$.executions') AS e
        WHERE json_extract(e.value, '$.run.id') = NEW.turn_id
          AND json_extract(e.value, '$.run.threadId') = NEW.thread_id
          AND json_extract(e.value, '$.cancelRequested') = 0
          AND json_extract(e.value, '$.run.outcome') = 'dispatching'
    )
)
BEGIN
    SELECT RAISE(ABORT, 'automation execution does not own this admission');
END;
