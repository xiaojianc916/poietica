# 0007. Unified failure coordinator

- Status: Accepted
- Date: 2026-07-24
- Scope: Complete renderer failure architecture

## Decision

Poietica uses one FailureIncident model and one FailureCoordinator.

FailureCoordinator owns:

- recoverable operation failures;
- feature degradation;
- document quarantine;
- application terminal failure;
- native terminal failure;
- deduplication;
- occurrence counting;
- scope resolution;
- subscriber notification.

Fatal runtime is a source adapter only. It does not own state.

UI components are projections of the coordinator snapshot and do not classify
or store failures independently.

Failure diagnostics are generated once when the incident is created.

## Removed parallel systems

- FailureRuntime;
- FatalIncidentController;
- FatalIncident;
- separate fatal state store;
- separate non-terminal state store.

## Invariants

The first distinct terminal incident remains the primary terminal cause.

Recoverable failures cannot become terminal without an explicit terminal impact.

Document failures are isolated to their document scope.

Feature degradation remains after notification dismissal.

Native and renderer fatal failures use the same incident and diagnostic model.

## Terminal presentation

React and pre-React terminal renderers consume one pure
TerminalFailureViewModel.

The ViewModel owns title, description, summary, recovery presentation,
additional-incident text and formatted diagnostics.

Renderers own only platform-specific element creation, clipboard state and
execution of the selected primary action.

Neither renderer may classify failure impact or format diagnostics directly.
