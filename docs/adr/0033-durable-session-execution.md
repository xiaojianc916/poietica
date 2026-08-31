# ADR 0033: Durable session execution ownership

PromptAdmitted is committed before KAP admission. A process-global coordinator owns one FIFO mailbox per session; different sessions run independently. KAP is the sole owner of main and subagent execution. Frames and cursors are durable before projection. Cancellation is rooted at the connection, descends through session and admission tasks, requests KAP abort, then joins local tasks.

KAP 0.39.1 accepts a client prompt_id for ordinary prompt submissions. Transport-ambiguous failures are retried with the same identifier and a bounded budget; envelope rejections are terminal. KAP rejects prompt_id when skills are bundled, so those submissions are sent once and an ambiguous outcome remains indeterminate.
