<div align="center">

# Poietica

### Make space for unfinished ideas.

**A local-first, AI-agent desktop environment for thinking, exploring, and creating.**

[![Quality](https://github.com/xiaojianc916/poietica/actions/workflows/quality.yml/badge.svg)](https://github.com/xiaojianc916/poietica/actions/workflows/quality.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-2783DE?style=flat-square)](./LICENSE)
[![Desktop](https://img.shields.io/badge/platform-desktop-46A171?style=flat-square)](https://v2.tauri.app/)
[![Local first](https://img.shields.io/badge/data-local--first-D5803B?style=flat-square)](#why-local-first-matters)

[Get started](#get-started) · [Architecture](#architecture) · [Documentation](#documentation)

</div>

---

> **Poietica does not try to create instead of you.**  
> It helps you keep creating while your thoughts are still incomplete.

Creative work rarely begins with a polished plan. It starts with an unfinished sentence, a
question, a reference, or a direction that has not become clear yet.

Poietica brings those fragments into one place: a conversation. You describe where you are
stuck, the agent works with tools, skills and MCP servers, and every step stays inspectable
and reversible.

<br>

<div align="center">

`Describe` &nbsp;→&nbsp; `Converse` &nbsp;→&nbsp; `Delegate` &nbsp;→&nbsp; `Review` &nbsp;→&nbsp; `Create`

</div>

<br>

## ✦ What it is for

<table>
  <tr>
    <td width="50%" valign="top">

### Start anywhere

Begin with a sentence, a question, or an unfinished thought. A conversation is the workspace.

</td>
    <td width="50%" valign="top">

### Explore without surrendering control

The agent offers questions, perspectives, and editable proposals.

It never silently decides what your work should become.

</td>
  </tr>
  <tr>
    <td width="50%" valign="top">

### Delegate with boundaries

Tools, skills and MCP servers act only inside explicit, inspectable runs.

Every tool call is recorded and can be replayed.

</td>
    <td width="50%" valign="top">

### Keep work close

Runs are local-first. The event log is written before anything is rendered, so an
interrupted run can always resume.

</td>
  </tr>
</table>

## ◌ The agent environment

| Surface | What it helps with |
| --- | --- |
| **Converse** | Work with an agent in a first-class conversation. |
| **Tools** | Manage built-in tools, skills and MCP servers. |
| **Automations** | Arrange background flows that run on their own. |
| **Hooks** | Attach programmable extension points at key moments. |
| **Search** | Find conversations, tools and content across the workspace. |

<details>
<summary><strong>Why local-first matters</strong></summary>

<br>

Your work belongs to you. Poietica is designed around predictable local behavior:

- runs are persisted before they are rendered;
- application-owned state is persisted locally;
- network and AI requests happen only through explicit product flows;
- external AI services receive only the context intentionally selected for them.

Where each file lands on disk — and what a backup has to carry — is documented in
[`docs/architecture/data-layout.md`](./docs/architecture/data-layout.md).

</details>

## ⚑ Current status

> **Active development**  
> The current focus is the reliable agent foundation: typed IPC, durable local run
> persistence, tool and MCP execution, and bounded AI workflows.

The project is intentionally building reliability before broadening the product surface.

## ◈ Technology

<div align="center">

| Interface | Agent transport | Desktop runtime | Tooling | Validation |
| :---: | :---: | :---: | :---: | :---: |
| React + TypeScript | kap | Tauri + Rust | Bun + Turborepo + Vite | Biome + bun test + Valibot |

</div>

<br>

- **React + TypeScript** — product interaction and interface composition.
- **kap** — the single transport between the desktop client and coding agents.
- **Tauri + Rust** — desktop integration, durable local state, system capabilities, security boundaries.
- **Bun + Turborepo** — workspace management and task orchestration.
- **Biome** — formatting and static analysis.
- **bun test** — unit and integration tests across the workspace.
- **Valibot** — runtime validation at file, IPC, AI, and application boundaries.

## Get started

### Prerequisites

| Tool | Required version |
| --- | --- |
| Bun | See `packageManager` in [`package.json`](./package.json) |
| Rust | See [`rust-toolchain.toml`](./rust-toolchain.toml) |
| Tauri prerequisites | [Platform setup guide](https://v2.tauri.app/start/prerequisites/) |

### Run Poietica locally

```bash
git clone https://github.com/xiaojianc916/poietica.git
cd poietica

bun install
bun run dev
```

### The only two commands you need

| Command | Purpose |
| --- | --- |
| `bun run dev` | Run the desktop application in development. |
| `bun run check` | Repository checks: Biome, architecture rules, types, tests, Rust, and generated IPC. |

Run `bun run` to list every script. This file deliberately does not mirror that list — a command table copied out
of `package.json` rots silently, and this one already had an entry that no longer existed.

## Architecture

Poietica is a monorepo with deliberately strict ownership boundaries.

```text
apps/desktop/src/        Product interface and application composition (TypeScript)
apps/desktop/src-tauri/  The single composition root: windows, commands, DTO conversion
crates/                  Native Rust crates — host-agnostic, testable without Tauri
packages/                TypeScript workspace packages, tiered, dependencies point downward
docs/                    Architecture notes, decision records, proposals, runbooks
scripts/                 Repository tooling: release, git hooks, clean
tools/architecture/      The machine-executable half of the architecture
```

Three invariants hold everywhere:

1. **The event log is the source of truth for every run.** Session updates are persisted
   before they are rendered, so an interrupted run can always be replayed. Threads, runs,
   tool calls and permission records are projections of that log, never a second copy.
2. **Dependencies point downward only.** Packages are tiered, and a package may import from
   its own tier and below. Only the transport, composition and application layers may touch
   `@tauri-apps/*`; platform capability never leaks into domain or foundation packages.
3. **Every kind of state has one owner and one write path.**

The tier table itself lives in [`tools/architecture/rules.config.mjs`](./tools/architecture/rules.config.mjs)
and is reconciled against the packages on disk every time the checks run. No document
restates it — four hand-copied copies once disagreed with each other, and only the
configuration was ever executed.

## Documentation

| Document | Purpose |
| --- | --- |
| [Engineering guide](./AGENTS.md) | Product invariants, architectural boundaries, and the rules a change must satisfy. Start here. |
| [Architecture notes](./docs/architecture/README.md) | System boundaries, native layering, disk layout, UI authority. |
| [Architecture checks](./tools/architecture/README.md) | Every machine-enforced rule and how to add one. |

## Contributing

Contributions should preserve the guarantees that make Poietica trustworthy:

- **one source of truth** for each kind of state;
- **one normal write path** for every conversation and run;
- **no silent AI edits** to user work;
- **explicit and minimal AI context** for external requests;
- **validated boundaries** for files, paths, images, clipboard data, AI output, plugins, IPC;
- **no platform capability leakage** into product-domain or foundation packages;
- **no permanent parallel implementations** created as shortcuts.

Before opening a pull request:

```bash
bun run check
```

## License

Poietica is released under the [Apache License 2.0](./LICENSE).

<div align="center">

<br>

**Build a place where unfinished ideas can keep becoming.**

</div>
