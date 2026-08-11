# 0011. No vendored shadcn components in the agent feed

Date: 2026-07-25

## Status

Accepted. Refines ADR 0008.

## Context

The agent feed was going to be built on AI Elements, vendored through the
shadcn registry. Three problems surfaced during integration.

AI Elements is built on the Radix flavour of shadcn/ui. This repository's
design system is Base UI, and `tools/architecture/check-ui-boundaries.mjs`
already treats Base UI as the only primitives library allowed outside the
design system. There is no Base UI build of AI Elements; the request has been
open upstream since February 2026 as vercel/ai-elements#383, filed by someone
hitting exactly this mismatch. Vendoring therefore means two headless
libraries in one application, permanently.

The components also carry their own icon set, their own syntax highlighter and
their own styling utilities, each of which duplicates something this
repository already chose.

Most importantly, the tool component models state as the AI SDK's seven part
states. Our domain speaks ACP, whose tool calls have four statuses. Adopting
the component means maintaining a translation between two models for the
lifetime of the project, and depending on the `ai` package to do it, which
contradicts ADR 0008.

## Decision

Only Streamdown is kept, with its cjk, code, math and mermaid plugins. It
solves incremental parsing of markdown that is still arriving, which is not
something worth reimplementing.

The surfaces of the feed are written in this repository against the ACP model:
a disclosure built from a button and an aria-controlled region, a tool card
whose status union is the ACP one, a plan panel and a single markdown entry
point. `prompt-input.tsx`, which was already self contained, stays as it is.

## Consequences

The feature package depends on Streamdown and its plugins, and on nothing
else external. Radix, class-variance-authority, clsx, shiki, lucide-react and
`ai` all leave the dependency graph.

Upstream improvements to AI Elements no longer arrive for free. Given that the
components would have needed rewriting at the state machine level anyway, that
cost is already being paid.

Accessibility of the disclosure is now our responsibility, and is covered by
the component tests.
