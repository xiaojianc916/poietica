//! 为浏览器面板打包 element picker 运行时。
#![allow(
    clippy::expect_used,
    clippy::panic,
    reason = "a build script reports failure by panicking; it never runs in the shipped app"
)]

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

/// npm 前缀里 bun 真身的位置；前缀根本身只放 shim。
fn bun_exe_under(prefix: &Path) -> PathBuf {
    prefix.join("node_modules/bun/bin/bun.exe")
}

/// Windows 的 npm 只装 bun.cmd / bun.ps1 shim，[`Command`] 两个都执行不了
/// （ps1 连 `CreateProcess` 都过不去，报 os error 193），故一律解析到 bun.exe。
fn find_bun() -> PathBuf {
    if let Some(bun) = env::var_os("BUN") {
        let bun = PathBuf::from(bun);
        // BUN 指到 shim 时取同前缀下的真身：`Get-Command bun` 给出的正是 bun.ps1。
        return match bun.parent().map(bun_exe_under) {
            Some(exe) if exe.is_file() => exe,
            _ => bun,
        };
    }

    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        let mut prefixes = Vec::new();

        if let Some(prefix) = env::var_os("NPM_CONFIG_PREFIX") {
            prefixes.push(PathBuf::from(prefix));
        }

        if let Some(home) = env::var_os("USERPROFILE") {
            let home = PathBuf::from(home);
            if let Ok(content) = std::fs::read_to_string(home.join(".npmrc")) {
                for line in content.lines() {
                    if let Some((key, value)) = line.split_once('=')
                        && key.trim().eq_ignore_ascii_case("prefix")
                    {
                        prefixes.push(PathBuf::from(value.trim()));
                    }
                }
            }
            // 独立安装的 bun：不是 npm 前缀，真身直接躺在 bin 下。
            candidates.push(home.join(".bun/bin/bun.exe"));
        }

        if let Some(appdata) = env::var_os("APPDATA") {
            prefixes.push(PathBuf::from(appdata).join("npm"));
        }

        // shim 所在目录就是 npm 前缀根，而它必然在 PATH 上（`bun dev` 能跑起来即证）。
        if let Some(path) = env::var_os("PATH") {
            prefixes.extend(env::split_paths(&path));
        }

        candidates.extend(prefixes.iter().map(|prefix| bun_exe_under(prefix)));

        if let Some(bun) = candidates.into_iter().find(|candidate| candidate.is_file()) {
            return bun;
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
                "failed to run bun at {}: {error}. Set BUN to the full path of bun.exe, not to a \
                 bun.cmd / bun.ps1 shim.",
                bun.display()
            )
        });

    assert!(
        result.status.success(),
        "element picker bundle failed:\n{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
