# AI activity feed

The feed is a projection, never a source of truth.

    kap_event  ->  run event log  ->  reducer  ->  timeline  ->  selectors  ->  feed rows

Rules that hold at every step:

- The reducer is pure and replayable. Rendering a persisted run and watching a
  live one execute the same code path.
- Entries are typed, not roles. A tool call is addressable by its tool call id
  because the protocol updates it by id.
- The feed host owns scrolling and measurement only. Entry rendering is injected,
  so entry design can change without touching virtualisation.
- Stick-to-bottom follows user intent: once the reader scrolls up, a streaming
  run must not pull them back down.

## Next step

Vendor the AI Elements output components into packages/agent-ui/src/ai-elements
with the official CLI, then replace TimelineItemPreview with renderers built on
them, driving markdown through Streamdown:

    npx ai-elements@latest add response reasoning tool task actions sources

TimelineItemPreview is scaffolding. It carries no design decisions and is deleted
in that step.
