# ADR 0030: Durable session execution ownership

PromptAdmitted is committed before KAP admission. A process-global coordinator owns one FIFO mailbox per session; different sessions run independently. KAP is the sole owner of main and subagent execution. Frames and cursors are durable before projection. Cancellation is rooted at the connection, descends through session and admission tasks, requests KAP abort, then joins local tasks. Ambiguous prompt POST failures are never retried because KAP exposes no client idempotency key.
