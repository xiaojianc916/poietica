# Conversation ownership and recovery

Status: accepted with the validated source change.

## Decision

The desktop runtime owns conversation services and update services. React receives their
references and owns only view subscriptions and transient presentation state. Automation
execution is an ordinary injected application function, not a React component.

A session transcript replica owns official per-agent reducers, committed sequence cursors,
and ordered recovery work. Disposal invalidates pending results. Historical pagination
merges referenced entities without advancing the live cursor. No second reducer is introduced.

Native transcript events are validated at the existing boundary. Invalid events do not escape
the listener. Automated prompts use the same configuration-and-submit path as ordinary prompts.
Missing submitted attachment bytes reject delivery rather than silently changing user intent.

## Consequences and limits

Only one implementation remains for each replaced responsibility. Existing KAP schemas,
IPC generation, database migrations, lockfiles and the desktop Turbo task graph are retained.
The migration script applies source changes directly in the working tree and validates the
repository in place after application.

This decision does not claim completion of native use-case extraction, cross-process physical
cancellation, a complete file-level dependency DAG, or command-to-agent-turn correlation.
Local optimistic presentation still requires that correlation before it can be separated
completely from authoritative transcript projection. A passing package-level gate is not
proof that those remaining architecture requirements are satisfied.

## Verification

Run the repository check entry point. Permanent tests cover per-agent ordering, duplicate
batches, incomplete catch-up, stale completion after disposal, historical entity merging,
terminal-wait cancellation, automation submission arguments and TypeScript import syntax.
Desktop interaction, actual shutdown and real-agent integration need separate execution.
