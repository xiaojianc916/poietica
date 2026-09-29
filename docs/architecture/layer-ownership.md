# Layer ownership

Desktop entry composes, starts and releases owners. Workbench integrates product
views; it does not construct native gateways. Assistant policy receives session
ports, preferences and reporting explicitly.

## State and lifetime

- Conversation runtime owns renderer conversation projections and subscriptions.
  Agent transcript facts are not owned by components.
- Agent policy owns its activation lifetime, launch prerequisites and
  preference-selection decisions. Native shutdown owns the process.
- Workbench receives stable host operations; review and terminal keep their
  workspace keys and existing resource lifetimes.
- Each asynchronous native listener registration has one release owner. A late
  registration is released immediately after cancellation.

## Domain flows

Each product surface has exactly one native owner, one generated contract and
one renderer port. Views consume injected ports; they do not construct native
state.

| Domain | Native owner | Contract | Renderer port | View |
| --- | --- | --- | --- | --- |
| Browser | `crates/browser` (Tabs) | `browser_*` IPC | `native-bridge` | `packages/browser` |
| Review | `crates/review` | `review_*` IPC | `native-bridge` | `packages/review` |
| Terminal | `crates/terminal` (PTY) | `terminal_*` IPC | `native-bridge` | `packages/terminal` |
| Conversation | `crates/agent-client` + `crates/ledger` | `agent_*` IPC + transcript events | `native-bridge` | `packages/conversation` |

## File direction

- Entry imports workbench and domain code. Workbench and domains never import
  entry, including through erased types.
- Workbench shell consumes workspace composition; workspace consumes surfaces
  and dock; dock consumes lazy leaf panes. The runtime contract has no view
  dependency.
- Native conversation public exports expose concrete ports. Port implementations
  consume launch contracts, event subscription and decoding; those leaves do not
  import port implementations or their public entry.
- The executable file-direction tables own the allowed edges. Dynamic loads and
  compiler-resolved aliases use the same file graph.

## Toolkit and transport

The host command schedules the complete synchronous toolkit collection in a
blocking task. Agent capability and model metadata come from the agent (ADR
0017); extension owns the bounded skill-document read. The renderer does not
merge inventories.

Rust output types remain the source for generated IPC bindings. Moving ownership
must not change the generated transport surface. A started blocking task is not
cancellable merely because its caller stopped waiting.

## Verification

Policy tests use injected ports without Tauri. Native subscription tests
exercise late release and handler isolation. Toolkit tests run without an
application host. Architecture tests cover allowed edges, reverse edges, aliases
and erased types. The repository check and desktop build remain required;
process cancellation, restoration and shutdown also require application-level
regression tests.
