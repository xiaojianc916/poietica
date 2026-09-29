# Windows build prerequisites

The native crates in this workspace compile C source as part of the build. On
Linux and macOS the required tools are already present, so this page is mostly
about Windows.

## What has to be installed

| Tool | Needed by | Needed at run time |
| --- | --- | --- |
| MSVC build tools | every native crate | no |
| Rust, via rustup | every native crate | no |
| Perl | OpenSSL's `./Configure` | no |

Nothing on this list is shipped to end users. These are build-time
prerequisites only.

### Perl

`poietica-agent-persistence-native` depends on `rusqlite` with the
`bundled-sqlcipher-vendored-openssl` feature. That feature compiles SQLCipher
and OpenSSL from C source and links them statically, which is what lets the
application open an encrypted database on a machine that has no OpenSSL
installed.

OpenSSL has configured itself through `./Configure` — a Perl script — for
decades. Without Perl on `PATH`, the `openssl-sys` build script fails with:

```
Error configuring OpenSSL build:
Command 'perl' not found. Is perl installed?
```

Install it once:

```powershell
winget install -e --id StrawberryPerl.StrawberryPerl
```

Then **open a new terminal** so `PATH` is refreshed, and confirm:

```powershell
perl -v
```

NASM is **not** required. `openssl-src` passes `no-asm` for the
`x86_64-pc-windows-msvc` target, so OpenSSL's assembly routines are never
built.

## Checking the host

```bash
bun run check
```

The checks exit non-zero on the first missing toolchain piece; each failure names
the tool it wanted.

## First build is slow

The first `cargo build` or `cargo test` after a clean checkout compiles
SQLCipher and OpenSSL from C source. This is silent for several minutes and is
CPU-bound, not network-bound. The result is cached in `target/`, so later
builds do not repeat it.

## Toolchain

`rust-toolchain.toml` tracks the `stable` channel rather than an exact
version. Pinning an exact version makes rustup provision a duplicate toolchain
even when the identical compiler is already installed, and that download comes
from `static.rust-lang.org`, which no cargo registry mirror covers. The real
lower bound is `rust-version` under `[workspace.package]` in the root
`Cargo.toml`; Cargo enforces it natively and reports a readable error.

## Building the embedded agent

The agent ships inside the app as **its own Bun runtime plus our bridge**, not as a
compiled executable of ours: `tools/agent/prepare-runtime.ts` copies the Bun that is
running the script, bundles `packages/agent-bridge` (which imports the oh-my-pi SDK)
with `Bun.build({ target: 'bun' })`, and copies the platform `pi-natives` `.node`
next to both. Tauri picks all three up as `bundle.resources`, so the shipped
installer needs no separate CLI and no Bun on the machine.

`bun run build:debug`, `bun run build:release` and `bun run dev` all run it
first; to prepare the runtime on its own:

```bash
bun run agent:prepare
```

It lands in `apps/desktop/src-tauri/binaries/` (gitignored). Every file lands beside
the installed `poietica.exe` verbatim — the runtime is found there first and the
bridge entry is only ever looked for there, because running a same-named script from
`PATH` would be a different program.

The platform `.node` is chosen the way the SDK's own loader chooses it — from Node's
`process.platform`/`process.arch`, with the filename read from the leaf package's
`main` field — so this step needs **no Rust toolchain**: `bun dev` works on a machine
that has Bun but no rustc.

The end-to-end test drives the real bundle, and skips itself when it is absent:

```bash
cargo test -p poietica-agent-client --test bridge
```

It does not need a model or credentials: it proves the process starts, the
handshake completes, a session opens and a command round-trips. A live model
turn is a separate, future verification (see ADR 0016's "待验证" section).

Nothing here is worked around in code. A client that silently rewrites the
command it was given, or that treats a missing runtime as a transport error,
hides exactly the information the person running it needs.
