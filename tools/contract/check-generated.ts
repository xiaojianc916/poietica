#!/usr/bin/env bun
/**
 * CI 漂移门禁：先重生 ipc-bindings.ts，再断言工作区没有因它而变。
 *
 * 两侧必须逐字一致——Rust 的 surface() 是唯一事实，TS 侧的任何手工修改都
 * 会在下一次生成时被冲掉。红即说明有人改了其中一侧没同步另一侧。
 *
 * 跑法：bun run ipc:check（package.json）。
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bindings = 'packages/contract/src/generated/ipc-bindings.ts'

const generate = spawnSync('bun', ['tools/contract/generate-ipc.ts'], {
  cwd: repo,
  stdio: 'inherit',
})

if (generate.status !== 0) {
  process.exit(generate.status ?? 1)
}

const diff = spawnSync('git', ['diff', '--exit-code', '--', bindings], {
  cwd: repo,
  encoding: 'utf8',
})

if (diff.status !== 0) {
  process.stderr.write(`ipc check: ${bindings} drifted from the generated surface\n`)
  process.exit(1)
}
