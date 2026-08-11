# 0002. Unified fatal incident architecture

- Status: Superseded
- Superseded by: ADR 0007
- Date: 2026-07-24
- Owners: Desktop application composition root

## Context

Poietica previously implemented multiple unrelated failure paths:

1. a static HTML startup card and bootstrap error renderer;
2. an application-level React error boundary;
3. a workspace-level UI error boundary;
4. console-only global error and unhandled-rejection reporting.

These paths did not share state, diagnostics, recovery semantics or visual
presentation. The workspace boundary also made a failure of the complete editor
surface appear to be a recoverable local feature failure.

Native Rust process crashes form a separate physical boundary: once the native
process terminates, the WebView cannot render a React error screen.

## Decision

Poietica uses one fatal incident model and one terminal fatal state.

### Ownership

- `fatal-incident.ts` owns normalization and the diagnostic snapshot.
- `FatalIncidentController` owns terminal fatal state and deduplication.
- `fatal-runtime.ts` owns the application singleton.
- `fatal-collectors.ts` adapts browser and Vite failures.
- `FatalErrorBoundary` adapts React render failures.
- `FatalErrorHost` owns the only React global fatal presentation.
- `pre-react-entry.ts` renders the same view model before React is available.
- Rust diagnostics persist native panic reports for the next application launch.

### Fatal state

The first distinct fatal incident becomes the primary incident.

Later distinct incidents are counted and recorded but do not replace the primary
incident. Repeated incidents with the same fingerprint are deduplicated.

Fatal state is terminal for the current renderer lifetime. It cannot be cleared
by resetting component state. Recovery requires a reload or native restart.

### Error classes

The global fatal surface is only for failures where the application cannot
safely continue:

- bootstrap and runtime construction failure;
- uncaught renderer exception;
- unhandled Promise rejection;
- root React render failure;
- violated application invariant;
- previous native process panic;
- development-server compilation failure.

Expected operational failures remain local:

- document open, save and close failures;
- settings failure;
- native-window operation failure;
- import or export validation failure;
- optional feature and plugin failure;
- image, media and font resource loading failure.

### Diagnostics

A fatal incident freezes:

- incident ID and fingerprint;
- error code, kind and lifecycle phase;
- normalized technical message;
- JavaScript and React component stacks when available;
- source location;
- bounded and redacted context;
- recent bounded structured logs;
- runtime and browser information.

Sensitive keys, credentials, bearer tokens and user-directory components are
redacted before presentation.

Rust details remain local and cross the IPC boundary only through bounded,
generated DTOs. Native and renderer reports use incident identifiers for
correlation.

### Presentation

The fatal screen is a full-window application state, not a card or dialog.

It uses:

- one restrained warning icon;
- concise user-facing language;
- incident code and ID;
- reload and copy-diagnostics actions;
- collapsible technical details.

Normal startup renders no loading card.

## Rejected alternatives

- keeping separate startup and runtime error pages;
- resetting an Error Boundary to pretend that fatal state recovered;
- treating the complete workspace as a recoverable feature boundary;
- sending unrestricted Rust errors or filesystem paths to the renderer;
- treating all resource-loading failures as application fatal;
- allowing the fatal UI to depend on the normal workspace component tree;
- maintaining multiple global error stores.

## Consequences

### Positive

- startup, runtime, React, Vite and native recovery use one diagnostic model;
- diagnostics are useful for debugging and bounded for safety;
- global failure behavior is deterministic and testable;
- local operational errors remain local;
- no second conversation or run state model is introduced.

### Costs

- native crashes can only be presented on the next launch;
- every new fatal source needs an explicit collector adapter;
- recovery actions require lifecycle-specific testing;
- diagnostic redaction rules must evolve with new data sources.

## Verification

The decision is enforced by:

- fatal incident unit tests;
- fatal controller state-machine tests;
- diagnostic buffer tests;
- native crash recovery tests;
- architecture checks preventing legacy boundaries and loading UI;
- TypeScript strict type checking;
- Rust tests and Clippy.
