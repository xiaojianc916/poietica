# Transcript recovery ownership

Status: Accepted

## Decision

Kimi owns transcript content. Rust transports transcript envelopes without reducing them.
The native boundary validates official payload schemas and emits domain signals.
TranscriptReplica exclusively owns the local official reducers and per-agent recovery work.

A reset retires the agent's Feed identity, including its queue and cursor. Obsolete work
cannot publish or report an error against a successor. It does not cancel native I/O.
A session resync reloads the main roster before recovering the remaining agents.
Opening responses seed only an unowned feed; later openings republish committed
state and synchronize rather than replacing an active recovery baseline.

WS reset is an invalidation barrier, not the visible history window: the upstream
broadcaster can send a zero-turn tail. REST restores the loaded turn count and oldest
visible ordinal before one local snapshot commit. No discarded history is recovered
from stale local data. Pagination must advance or fail explicitly.

A complete catch-up sequence is validated before application. An offset gap rolls
back the local application checkpoint before authoritative recovery. Empty accepted
sets advance the cursor without publishing another projection.

## Boundaries

The reducer and schema implementations remain upstream-owned. Product projection,
submission intent and durable delivery retain their existing owners. There is no
parallel transport or reducer implementation and no persistent recovery checkpoint.
Request cancellation across IPC and contract release governance are separate work.

## Evidence

https://github.com/MoonshotAI/kimi-code/blob/95478e8c7ba248fd2470d5bb151555ec7fedd19d/packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts
https://github.com/MoonshotAI/kimi-code/blob/95478e8c7ba248fd2470d5bb151555ec7fedd19d/packages/kap-server/src/services/transcript/transcriptService.ts
