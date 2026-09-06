# Architecture Overview

## Ownership

Packages are bounded contexts, not separate copies of model and UI layers.
A domain owns its commands, state and projections. Views consume injected owners.
The default public entry is headless; view entries are explicit package subpaths.

Conversation owns local submission intents until delivery is acknowledged.
The agent owns accepted prompts and transcript facts. Official reducers project those facts.
A conversation queue outlives its views; forgetting the conversation disposes the queue.
Uncertain delivery pauses automatic release instead of replaying an ambiguous command.

## Dependencies

tools/architecture/layering.ts declares layer groups and allowed peer-domain edges.
Both manifest and source checks use that decision. Undeclared peer edges are forbidden.
Cross-package access uses exports. Same-domain implementation uses relative module paths.
The runtime file graph rejects cycles and opaque loads and follows headless entries transitively.
Erased type-only file edges are not runtime cycles; package direction still applies to them.
Native integration consumes domain headless entries, including through compiler-resolved aliases.

## Composition and contracts

Desktop entry code assembles, starts and releases application owners.
Model policy, attachment intake, browser integration and window policy remain in their owning capabilities.
The existing native conversation runtime owns execution leases and recovery.
Rust IPC types and the shared command surface generate the renderer bindings.
There is no second protocol reducer, event bus or compatibility entry.

## Verification

bun run check validates types, tests, architecture, Rust and generated-contract drift.
A frontend production build additionally validates moved styles and asset imports.
Native reconnect, cancellation and shutdown behavior also require application-level testing.
ADRs retain historical decisions; this overview and executable policies describe the current structure.

See [UI authority](./ui-authority-boundaries.md), [Rust layers](./rust-layers.md),
[conversation execution](./conversation-execution-ownership.md) and [window lifecycle](./window-lifecycle.md).
