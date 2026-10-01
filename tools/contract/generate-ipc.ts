#!/usr/bin/env bun
/**
 * IPC 绑定的唯一生成入口：调原生侧的导出可执行文件，产物落 packages/contract。
 *
 * 命令清单与类型清单都在 apps/desktop/native/src/ipc/mod.rs —— 原生侧生成，渲染层消费。
 * 这个脚本只编排：跑成、验产物在且非空。静默失败会发布一份过时的 IPC 面，所以失败即停。
 *
 * 跑法：bun run ipc:generate（package.json）。产出禁手改。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bindings = join(repo, 'packages', 'contract', 'src', 'generated', 'ipc-bindings.ts')

const run = spawnSync('cargo', ['run', '-p', 'poietica', '--bin', 'export-ipc-bindings'], {
  cwd: repo,
  stdio: 'inherit',
})

if (run.status !== 0) {
  process.stderr.write(`ipc generate: export-ipc-bindings exited ${String(run.status)}\n`)
  process.exit(run.status ?? 1)
}

/* 编译过了但产物缺席/清空 = 导出路径漂移，按生成失败处理。 */
if (!existsSync(bindings) || statSync(bindings).size === 0) {
  process.stderr.write('ipc generate: bindings file is missing or empty\n')
  process.exit(1)
}
