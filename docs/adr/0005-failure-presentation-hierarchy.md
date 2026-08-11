# 0005. Failure presentation hierarchy

- Status: Accepted
- Date: 2026-07-24
- Scope: Recoverable, degraded, document and application failure presentation

## Decision

Failure impact determines presentation scope.

Recoverable failures use temporary toast feedback.

Feature degradation may use one temporary notification, but the owning control
must retain its disabled or degraded state independently from the toast.

Document fatal does not use toast as its primary presentation. It replaces only
the failed document editor with a lightweight inline unavailable state.

Application fatal and native fatal use the unified full-window fatal surface.

## Document isolation visual rules

The document unavailable state is not a card, dialog or global error page.

It must not use:

- large warning illustrations;
- card backgrounds;
- elevated shadows;
- thick borders;
- full-window overlays;
- expanded diagnostic stacks by default.

It uses:

- one restrained 20 to 24 pixel icon;
- one short title;
- one short scope explanation;
- lightweight text actions;
- an unobtrusive error code.

The application title bar, tabs, sidebars and other documents remain usable.

## Diagnostic action

Document diagnostic information is copied on demand. Technical details are not
displayed by default inside the editor surface.

## Lifecycle

Dismissing a toast never resolves document quarantine.

Document quarantine is cleared only after the owning document session is no
longer present in the workspace.
