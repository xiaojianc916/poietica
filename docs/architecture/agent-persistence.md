# Agent persistence

The crate `poietica-agent-persistence-native` at `crates/persistence` owns the
local index: what this machine has seen. Schema is in `src/schema/`, and the
migration list in `src/migrations.rs` is the only order that matters.

## What is stored here, and what is not

The transcript on screen is replayed from `run_events`. The agent keeps its own
copy, but that one is the model's context: it is restored by `session/load` so
the agent can carry on, and it never reaches a projection. The replay frames
carry no `prompt_admitted`, so segment boundaries would collapse if they did.

`threads` is authoritative rather than derived. Titles, pinning, workspace root
and ownership are decisions a person or this machine made, and no log can
rebuild them.

Attachment bytes live on the filesystem. `attachments` and `thread_attachments`
are the ledger for them, keyed by content digest.

## The frame log

`run_events` is append only. It is written in one place, the batching task in
the desktop seam (`commands/agent/turn.rs`), which records a batch before it
emits it, and read in one place (`agent_open_thread`).

`UNIQUE (thread_id, session_id, seq)` is the deduplication guarantee, and
`record_frame` resolves it with `ON CONFLICT DO NOTHING`: a redelivered frame is
refused by the database rather than by whichever caller happened to notice.

The key is per conversation, not per session. It was `(session_id, seq)` until
migration 3, which meant a forked conversation could not copy the log it was
forked from.

Because the key includes `seq`, the in-memory sequence line has to survive a
restart. It does not on its own: a reloaded session keeps its identifier while
its `RunSlot` is new and starts at one. `AgentStore::last_seq` reports the last
recorded position and `SeqLine::resume` picks up after it, in `addressing.rs`,
at the one place a stored session becomes a live address.

## Concurrency

Write ahead logging lets the interface read a conversation while a run is being
recorded. `connection.rs` reads back the mode the pragma actually settled on,
because a read-only directory or a network share silently answers `delete`.

Writes go through one connection (`AgentStore`, held by `LocalIndex`), because
the log's ordering is what the rest of the system depends on. Readers wait up to
`DEFAULT_BUSY_TIMEOUT`, five seconds, for the lock. Every call runs on a
blocking thread: a command that waited for the lock on the main thread would
stop the window from answering.

## Encryption

There is none. The database is opened with `rusqlite::Connection::open` and no
key pragma, and the crate depends on neither SQLCipher nor a credential store.
The reason is in `lib.rs`: what is kept here is an index, and seven columns of
metadata protect nothing from anyone who can already read the agent's own
plaintext transcript. Secrets never reach this file; they are written by the
agent's own CLI into its managed home.
