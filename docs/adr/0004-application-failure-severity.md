# 0004. Application failure severity architecture

- Status: Superseded
- Superseded by: ADR 0007
- Date: 2026-07-24
- Scope: Application, presentation, renderer fatal runtime and native recovery

## Context

Errors were previously divided only into local UI errors and global fatal
incidents. Local UI errors were identified by arbitrary message strings and
delivered through browser CustomEvent instances.

That model could not represent feature degradation and allowed presentation
code to infer severity.

## Decision

Poietica defines four failure impacts:

1. recoverable — the operation failed but the owning state remains valid;
2. feature-degraded — one optional feature is unavailable;
3. application-fatal — the renderer cannot safely continue;
4. native-fatal — the native process terminated unexpectedly.

Failure impact, scope and recovery are separate concepts.

The canonical model belongs to packages/core. It contains no React, Tauri
or presentation dependency.

Non-terminal failures are owned by FailureRuntime. Terminal failures are owned
exclusively by the FatalIncidentController.

Presentation consumes structured failure state through an external store.
Browser CustomEvent is not an application state mechanism.

Rust IPC recoverable remains an operation retryability hint. The native layer
must not decide renderer presentation severity.

## Recovery rules

- recoverable: retry, dismiss or none;
- feature-degraded: retry, dismiss, disable-feature or none;
- application-fatal: reload, restart, exit or none;
- native-fatal: restart, exit or none.

Invalid impact, scope and recovery combinations are rejected.

## Ownership rules

Feature degradation requires a feature scope.

Application fatal requires application scope.

Native fatal requires native-process scope.

A dismissed feature notice does not automatically restore that feature.

## Consequences

The UI no longer guesses severity from an error string.

Repeated failures are deduplicated and counted.

Feature degradation survives notice dismissal until the owning scope explicitly
resolves it.

Global fatal UI remains reserved for application and native terminal failures.
