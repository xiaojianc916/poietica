# 0006. Feature degradation enforcement

- Status: Accepted
- Date: 2026-07-24
- Scope: Desktop feature availability

## Context

A feature-degraded notification is not sufficient if the related control
continues invoking the failed feature.

## Decision

FailureRuntime.degradedFeatures is the source of truth for session-level feature
availability.

Settings, developer tools, native window controls and window dragging consult
that state before executing.

Window minimize and maximize buttons use native disabled semantics.

The application close button remains available even if close-request
coordination is degraded.

## Presentation

Feature degradation does not use a card, modal or global error page.

Unavailable controls use restrained disabled opacity and a short native title.

## Recovery

A feature remains unavailable after its notification disappears.

Only the owning integration may restore it by resolving the corresponding
feature scope in FailureRuntime.
