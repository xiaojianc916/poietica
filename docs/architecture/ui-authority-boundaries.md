# UI authority boundaries

## Status

Accepted architecture boundary.

## Goal

Poietica does not require every UI component to live in the design-system
package. It requires every cross-feature visual rule and reusable interaction
primitive to have exactly one authority.

## Authority matrix

| Capability | Authority |
| --- | --- |
| Semantic colors, typography, radii, shadows, focus, motion | `packages/ui` |
| Reusable accessible interaction primitives | `packages/ui` |
| Workspace grid, sidebar and main-region layout | `packages/workspace` |
| Settings content and settings workflow | `packages/settings` |
| Native window chrome and Tauri-specific presentation | `apps/desktop` |
| Failure classification and recovery policy | application composition |
| Generic toast presentation | design-system |

## Design-system rules

- The design system contains no workspace, settings or desktop-window
  business semantics.
- Base UI is wrapped by the design system before feature packages consume it.
- Feature packages may compose primitives but must not recreate generic dialog,
  menu, tooltip, select, combobox or toast interaction kernels.
- Product-layout dimensions do not belong to global design-system tokens.
- Public consumers import only from `@poietica/design-system`.

## Migration rule

When a new authority replaces an old implementation, the old implementation,
token family, style rule and export must be removed in the same migration. The
repository must not maintain indefinite dual UI paths.
