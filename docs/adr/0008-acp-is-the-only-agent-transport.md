# 0008. ACP is the only agent transport

> 传输选型部分已由 ADR 0025 取代。

> Status: superseded by ADR 0022.

- Status: accepted
- Date: 2026-07-25
## Context

Poietica needs an agent surface that shows reasoning and tool execution as it happens.
Two candidate channels existed: a direct provider channel built on the Vercel AI SDK,
and the Agent Client Protocol (ACP), which already standardises session lifecycle,
streaming updates, tool-call reporting and permission requests.

ACP reports tool calls through session/update notifications with the statuses
pending, in_progress, completed and failed. That is exactly the data a tool-call
trace UI needs, and it is a published protocol rather than an in-house invention.

## Decision

ACP is the only agent transport. The direct provider channel is dropped, and with it
the runtime dependency on the Vercel AI SDK. AI Elements components are still used,
but purely as presentation; they carry no transport responsibility.

Kimi Code CLI is the first agent, launched as an ACP agent server.

## Consequences

- One event vocabulary, one reducer, one timeline. No dual-track agent runtime.
- Provider fan-out becomes the agent’s concern, configured through its own settings.
- Capabilities the protocol does not expose are unavailable until the protocol adds them.
  This is accepted deliberately over re-inventing a private protocol.
