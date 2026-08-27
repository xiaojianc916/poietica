# ADR 0031 — User Agent files are the customization source

## Status

Accepted

## Context

Kimi Code discovers custom Agent Markdown files from its user, project, extra, explicit and plugin roots. The file frontmatter owns profile identity, tool gates and delegation gates; Kimi owns discovery and execution.

## Decision

Poietica edits only the Kimi-controlled user Agent directory. Markdown files are the sole persisted truth. A native, host-independent module performs bounded UTF-8 reads, path containment, atomic replacement and compare-and-swap conflict detection. Rust DTOs generate the renderer contract. The settings surface receives a store through the application composition root.

Poietica does not duplicate Agent discovery, tool enforcement, nested delegation, parallel execution or plugin resolution. It does not expose an independent-model control because the current Kimi v2 Agent file parser does not consume one.

## Consequences

New sessions see saved profiles through Kimi's official discovery path. Existing unknown frontmatter fields survive edits. Concurrent editors fail visibly rather than losing data. Runtime behavior remains owned by Kimi Code.
