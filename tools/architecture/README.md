# Architecture checks

`bun tools/architecture/run.mjs` is the only entry point. It walks the source
roots once, applies every rule declared in `rules.config.mjs`, and reports all
violations as `file:line:column`.

## Enforced invariants

Every invariant below maps to a rule id emitted by `run.mjs`. The layer table
lives in `rules.config.mjs` and is reconciled against the packages on disk at
load time; the dependency edges are read from the workspace manifests. This
file restates neither.

- `public-package-exports` — cross-package imports use public package exports, not `src/` deep
  paths.
- `no-cross-boundary-relative-imports` — relative imports do not cross top-level package
  boundaries.
- `{pkg}-owns-its-entry` — a package never imports itself by package name; inside a package,
  paths are relative.
- `layered-workspace-dependencies` — a workspace edge points down a layer, or is a listed
  same-layer exemption carrying a reason.
- `workspace-graph-is-acyclic` — the workspace dependency graph is a DAG.
- `every-package-is-reachable` — every package is reachable from an app.
- `native-host-access-is-declared` — only `desktop`, `desktop-adapters` and `ipc` declare
  `@tauri-apps/*`.
- `native-crates-stay-host-agnostic` — native crates set `[lints] workspace = true`, and depend
  on neither tauri nor each other.
- `window-surface-policy` — the native window, bootstrap root and WebView2 compositor keep one
  opaque, retained restore surface.
- `capability-scoped-directory-names` — a directory name states a capability; DDD layer names
  and catch-all buckets are refused at any depth.
- `workspace-manifest-conventions` — one public surface per manifest: `exports` without
  `main`/`types`, bare string targets, subpath names derived from the target, exact versions.
- `manifest-scripts-resolve` — a `bun <file>.mjs/.ts` entrypoint named in a manifest script
  exists on disk.
- `documented-scripts-exist` — a colon-scoped `Bun` script named in documentation exists in a
  manifest.
- `documented-packages-exist` — a `@poietica/*` package named in documentation exists in the
  workspace.
- `wildcard-module-declarations` — a `declare module "*.ext"` pattern has exactly one owner.
- `client-preferences-single-pipeline` — Web Storage is touched in exactly one file.
- `agent-identity-single-subscription` — the current agent id is subscribed once, at the
  composition root.
- `agent-capabilities-wired-at-the-root` — the capability port is installed once, at the
  composition root.
- `framework-free-domain` — domain packages never import React; hooks and Context stay in UI
  packages, projections and state stay testable in plain Node.
- `design-system-token-authority` — design-system components consume `--ui-*` tokens instead of
  raw utility classes.

A rule carries either a `pattern` (a regular expression matched against source
files) or a `check` (a function handed the single filesystem inventory). Both
report through the same violation list. Neither may throw at import time: that
would hide every other rule's findings, which is what this runner exists to
prevent.

## Adding a rule

Add an object to `rules.config.mjs`. Do not add a script.

Standalone `check-*.mjs` files are themselves a violation: they encode a single
migration as a text snapshot, outlive it, and rot without failing. Assertions
about one component's implementation belong in that component's tests, where
they are deleted together with the migration.
