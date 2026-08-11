CREATE TABLE workbench_session (
  slot       INTEGER PRIMARY KEY CHECK (slot = 0),
  document   TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
) STRICT;
