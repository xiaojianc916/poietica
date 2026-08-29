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

## Running the live kap turn

`cargo test -p poietica-agent-runtime-native --test live_turn -- --ignored` starts a
real Kimi Code kap server, so it needs one on the machine. It is not part of
`cargo test` and nothing else in the repository depends on it.

Three prerequisites, in order:

1. `kimi` has to be executable by name. The client spawns a program, not a
   shell, so a launcher installed as a script must be named in full on Windows.
   Check with `where.exe kimi` and override with `POIETICA_KAP_PROGRAM` if the
   resolved name differs.
2. Kimi Code has to be logged in. Without it the server starts and then refuses
   to create a session, which looks like a transport failure but is not one.
3. Loopback REST and WebSocket connections have to be allowed on this machine.

The overrides the test reads are declared in
`crates/agent-runtime/tests/live_turn.rs`:

- `POIETICA_KAP_PROGRAM`
- `POIETICA_KAP_ARGS`
- `POIETICA_KAP_PROMPT`
- `POIETICA_KAP_CWD`
- `POIETICA_KAP_TIMEOUT`
- `POIETICA_KAP_MODEL`
- `POIETICA_KAP_CAPTURE`
- `POIETICA_KAP_EXPECT`

None of these prerequisites is worked around in code. A client that silently
rewrites the command it was given, or that treats a login failure as a transport
error, hides exactly the information the person running it needs.
