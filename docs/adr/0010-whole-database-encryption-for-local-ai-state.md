# 0010. Whole-database encryption for local AI state

- Status: superseded by ADR 0018 — the run log this decision protected was removed by migration 0009_drop_run_log, and the remaining thread index is deliberately unencrypted
- Date: 2026-07-25
## Context

Agent runs persist prompts, reasoning, tool inputs and outputs, file paths and diffs.
This is some of the most sensitive material the product will ever store.

## Decision

AI state is stored in SQLite encrypted in full with SQLCipher. Not column-level
encryption: whole database, so that indexes, full-text search and the write-ahead log
are covered as well.

The key is a 32-byte random value held in the operating system keychain and supplied
as a raw key. It is never derived from, or stored alongside, the database file.
Re-keying must remain possible.

## Consequences

- Losing the keychain entry means losing the history; this must be stated in the UI.
- SQLCipher is linked into the desktop binary, so build and licence checks must cover it.
- Plaintext debugging dumps of the database are prohibited.
