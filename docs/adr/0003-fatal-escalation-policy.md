# 0003. Explicit fatal escalation policy

- Status: Superseded
- Superseded by: ADR 0007
- Date: 2026-07-24
- Scope: Desktop renderer and native crash recovery

## Context

A unified fatal screen is not sufficient by itself. The application also
needs a strict policy controlling which failures may enter terminal fatal
state.

Without an explicit escalation boundary, a recoverable document, settings,
resource or optional-feature failure can accidentally replace the entire
application with the global fatal UI.

## Decision

Production code must not call `FatalIncidentController.report` directly.

All production escalation passes through `reportFatalIncident` and declares
one of these impacts:

- `application-fatal`: the renderer cannot safely continue;
- `native-fatal`: the native process previously terminated unexpectedly.

The gateway records the selected impact in fatal diagnostic context.

The controller remains responsible only for terminal state, fingerprint
deduplication and listener notification. It does not infer severity from
arbitrary error messages.

## Non-fatal failures

The following failures must not use the fatal escalation gateway:

- expected file open, save, cancel or conflict errors;
- settings read or write failures;
- recoverable IPC errors;
- image, font, media and other resource loading failures;
- optional feature and plugin failures;
- document-scoped validation and import errors.

These failures must remain within their owning application or presentation
boundary.

## Fatal sources

Current approved fatal sources are:

- bootstrap runtime construction failure;
- uncaught browser ErrorEvent;
- unhandled Promise rejection;
- root React render failure;
- Vite development compilation failure;
- previous native process panic.

Adding another fatal source requires an explicit impact and an architecture
check update.

## Consequences

- accidental global escalation becomes harder;
- incident diagnostics show why a failure was promoted;
- the terminal state machine remains independent from browser and React;
- recoverable failures need their own local handling;
- architecture checks reject direct controller reports.
