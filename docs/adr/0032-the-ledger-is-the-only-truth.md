# 0032. The ledger is the only truth

- Status: Accepted
- Date: 2026-08-28

## Context

Conversation state was folded twice: once in Rust when rows were rebuilt into
sessions, and once in TypeScript when the same stream was turned into a timeline.
Two independent folds of one stream cannot be kept equal by review.

## Decision

The event ledger owns the truth. crates/conversation defines the vocabulary, the
turn state machine, the invariants and the ports. crates/ledger stores events in
SQLite and derives every view by replaying them. Readers consume the projection;
nobody folds raw events a second time.

## Consequences

- Any view can be dropped and rebuilt from conversation_events, so a damaged
  projection is no longer data loss.
- An admission and the delivery it owes are written in one transaction, so a
  resubmitted turn can never owe a second delivery.
- Writers go through the ports. Direct SQL from the composition root is a layering
  violation.
- The ledger is a new database with its own migrations. The persistence crate stays
  until the composition root is switched over, and is deleted in that same batch.
