# Agent persistence

## Ownership

The local SQLite file belongs to the application composition root. The append-only
conversation_events table is the only source used to replay the visible transcript.
The agent-side transcript remains model context and never feeds the screen projection.

threads owns titles, pinning, workspace roots, archival state, and the agent/session
address. Attachment bytes are content-addressed files; attachments and
thread_attachments own their references.

## Write and read execution

LocalIndex opens the database and finishes migrations before the webview starts. It
then gives the only writable AgentStore to poietica-ledger-writer and a query-only
connection to poietica-ledger-reader. Every mutation, including frame append,
admission, outbox, usage, cursor, disposal, workbench state, and reconciliation, is a
writer job. Read commands use only the read actor.

The writer actor provides one total write order. The independent reader preserves
SQLite WAL snapshot semantics, so a directory or transcript read cannot hold a
process mutex needed by frame persistence. Both connections use SQLite NO_MUTEX;
Rust ownership keeps each connection on one actor thread.

## Frame pipeline

A frame enters the bounded journal, is translated to ConversationEvent, and joins one
transactional AppendBatch. The batch implementation queries the starting sequence
once per thread, reuses one prepared INSERT, commits, and only then moves events into
EventEnvelope values for IPC emission. A failed transaction leaves the owned events
available for the journal retry loop.

Replay reads rows in order, deserializes each payload directly to ConversationEvent,
compacts adjacent text deltas in place, converts to the generated IPC DTO, and lets
Serde serialize once at the boundary. No generic JSON object is assembled and no raw
JSON page is retained beside its decoded form.

## Invariants

- Commit succeeds before any frame is emitted.
- One writer owns all mutations; there is no second write route.
- Read connections are query-only.
- Sequence numbers are allocated by the ledger transaction.
- Actor channels close with LocalIndex; the final owner joins both threads.
