# 0035 Computer Use install ownership

Status: Accepted

## Context

KAP starts capability installation as a background task. The desktop treated the start response as completion, discarded the official install state, and selected a Windows-only plugin id. The UI could therefore leave “installing” before the task settled and could not expose the installed plugin switch without a restart.

## Decision

- KAP owns capability installation and readiness.
- kap-client follows an existing task or starts one, then polls the official status until `install.running` is false.
- The OpenAPI snapshot generates the wire validator; the client maps that validated shape into a small domain model.
- The KAP-provided `pluginId` locates the plugin record.
- The plugin ledger owns presence and `enabled`. After capability installation settles, PluginStore rescans that ledger before publishing completion.
- The UI projects one rule: absent plugin means install; present plugin means switch.

## Consequences

There is one installation path, no platform id table, and no local copy of KAP progress. Installation errors and timeouts are visible. A settings-only cold start still requires the application-level agent connection owner; this decision does not add a second process lifecycle.
