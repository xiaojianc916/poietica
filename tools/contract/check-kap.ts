#!/usr/bin/env bun
/**
 * KAP 生成物的漂移门禁：先按快照重生，再断言工作区没有因它而变。
 *
 * 快照（contracts/kap/*.json）是唯一事实，generated/ 只许生成器写。红即
 * 说明有人手改了生成物、或快照刷新后忘了重新生成。
 *
 * 跑法：bun run kap:generated:check（package.json）。
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const generated = 'crates/kap-client/src/generated'

const generate = spawnSync('bun', ['tools/contract/generate-kap.ts'], {
  cwd: repo,
  stdio: 'inherit',
})

if (generate.status !== 0) {
  process.exit(generate.status ?? 1)
}

const diff = spawnSync('git', ['diff', '--exit-code', '--', generated], {
  cwd: repo,
  encoding: 'utf8',
})

if (diff.status !== 0) {
  process.stderr.write(`kap check: ${generated} drifted from the pinned snapshot\n`)
  process.exit(1)
}
