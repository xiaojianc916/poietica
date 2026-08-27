use std::env;
use std::path::PathBuf;
use std::process::Command;

/// Locate the bun executable.
///
/// On Windows, a bun installed via npm exposes only a `bun.cmd` shim on PATH;
/// the real `bun.exe` lives under `<npm-prefix>/node_modules/bun/bin/`. Rust's
/// [`Command`] does not resolve `.cmd`/`.bat` shims, so we search the common
/// install locations before falling back to plain `"bun"`.
fn find_bun() -> PathBuf {
    if let Some(bun) = env::var_os("BUN") {
        return PathBuf::from(bun);
    }

    #[cfg(windows)]
    {
        let mut candidates = Vec::new();

        if let Some(prefix) = env::var_os("NPM_CONFIG_PREFIX") {
            candidates.push(PathBuf::from(prefix).join("node_modules/bun/bin/bun.exe"));
        }

        if let Some(home) = env::var_os("USERPROFILE") {
            let npmrc = PathBuf::from(&home).join(".npmrc");
            if let Ok(content) = std::fs::read_to_string(&npmrc) {
                for line in content.lines() {
                    if let Some((key, value)) = line.split_once('=') {
                        if key.trim().eq_ignore_ascii_case("prefix") {
                            candidates.push(
                                PathBuf::from(value.trim()).join("node_modules/bun/bin/bun.exe"),
                            );
                        }
                    }
                }
            }
            candidates.push(PathBuf::from(&home).join(".bun/bin/bun.exe"));
        }

        if let Some(appdata) = env::var_os("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("npm/node_modules/bun/bin/bun.exe"));
        }

        for candidate in candidates {
            if candidate.is_file() {
                return candidate;
            }
        }
    }

    PathBuf::from("bun")
}

fn main() {
    tauri_build::build();

    println!("cargo:rerun-if-changed=../src/browser/element-picker-runtime.ts");
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed=../../../bun.lock");
    println!("cargo:rerun-if-env-changed=BUN");

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"))
        .join("element-picker.js");
    let bun = find_bun();
    let result = Command::new(&bun)
        .current_dir("..")
        .arg("build")
        .arg("src/browser/element-picker-runtime.ts")
        .arg("--outfile")
        .arg(&output)
        .arg("--target=browser")
        .arg("--format=iife")
        .arg("--minify")
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "failed to run bun at {}: {error}. Set the BUN environment variable to the full path of bun.",
                bun.display()
            )
        });

    if !result.status.success() {
        panic!(
            "element picker bundle failed:\n{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
