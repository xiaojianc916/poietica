CREATE TABLE session_disposals (
  session_id TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  noted_at   TEXT NOT NULL
) STRICT;
