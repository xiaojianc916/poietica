ALTER TABLE threads
ADD COLUMN archived_at TEXT;

CREATE INDEX threads_archived_at
ON threads (archived_at, updated_at DESC);
