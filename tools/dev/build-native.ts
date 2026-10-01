#!/usr/bin/env bun
/**
 * 把原生宿主编出来，并放到开发期唯一那个位置。
 *
 * 为什么需要改名：cargo 在 Windows 上把 cdylib 产出成 `.dll`，而 Node 只按 `.node`
 * 认插件（`require` 一个 `.dll` 会走 JS 解析器）。改名是加载器的要求，不是编译产物的
 * 名字 —— 所以它发生在 cargo 自己的 target 目录里，不另开第二个落点。
 *
 * 落点只有一处：`<仓库根>/target/<profile>/poietica.node`，就在 `.dll` 旁边。
 * 开发运行（electron/native.ts）与自检（electron/smoke.mjs）都读它，
 * 打包则由 electron-builder.yml 的 extraResources 从同一处取 release 版。
 *
 *   bun run native:build             # debug
 *   bun run native:build --release   # release（发布链路用）
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const release = process.argv.includes('--release')
const profile = release ? 'release' : 'debug'

const build = spawnSync(
  'cargo',
  ['build', '-p', 'poietica', '--lib', ...(release ? ['--release'] : [])],
  {
    cwd: repository,
    stdio: 'inherit',
  },
)

if (build.status !== 0) {
  process.stderr.write(`native:build: cargo 退出 ${String(build.status)}\n`)
  process.exit(build.status ?? 1)
}

/* 目标目录问 cargo 自己，不拼路径：CARGO_TARGET_DIR 或 .cargo/config.toml 都可能改道。 */
const metadata = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
  cwd: repository,
  encoding: 'utf8',
})
const targetDirectory = JSON.parse(metadata.stdout).target_directory

const dll = join(targetDirectory, profile, 'poietica.dll')
const addon = join(targetDirectory, profile, 'poietica.node')

if (!existsSync(dll)) {
  process.stderr.write(`native:build: cargo 没产出 ${dll}\n`)
  process.exit(1)
}

try {
  copyFileSync(dll, addon)
} catch (cause) {
  /* 上一次的 Electron 还开着就会锁住这个文件；这不是构建失败，是「先关掉它」。 */
  if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'EBUSY') {
    process.stderr.write(
      `native:build: ${addon} 正被占用 —— 先关掉正在运行的 Poietica/Electron，再重跑。\n`,
    )
    process.exit(1)
  }

  throw cause
}

console.log(`native:build: ${addon}`)
