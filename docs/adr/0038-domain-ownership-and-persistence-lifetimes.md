# Domain ownership and persistence lifetimes

Status: accepted for the change set, subject to its validation gates.

The ledger crate owns bounded SQLite execution lanes. Native commands decode input and convert typed failures, but do not implement the executor. Accepted writes complete even if the response waiter disappears.

The automation crate owns catalog data and mutation invariants. Its Rust types reach TypeScript through the existing generated contract and an explicitly type-only public entry. The transport command surface remains private to the native bridge. Catalog storage and event delivery remain host responsibilities. The rendering process still participates in scheduled execution; this decision does not certify native scheduling or cross-process cancellation.

Recovering an existing conversation never authorizes changing its identity. Load failures and an unmatched owner are reported; only a conversation without an assigned session receives a newly created session.

The workbench controller owns one pending complete snapshot and one active persistence operation. Disposal closes the write entrance and waits for the last result. The UI contract does not expose disposal; the application owner performs it after unmounting consumers.

No database migration, user-session deletion, or cron grammar change is included. Validation covers compilation, domain tests, generated contracts, and the web build. Desktop behavior and the complete native conversation lifecycle require separate end-to-end evidence.
