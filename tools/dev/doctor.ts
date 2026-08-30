#!/usr/bin/env bun
/**
 * 环境体检：构建链（bun / cargo / git）与 agent CLI（kimi）是否就位。
 *
 * 体检只报事实、不改环境。构建链缺席即失败；agent 缺席只是运行期功能受限，
 * 降为警告 —— 构建与测试不需要它在场。
 *
 * 跑法：bun tools/dev/doctor.ts（package.json 里无入口亦可直跑）。
 */

import { spawnSync } from 'node:child_process'
import process from 'node:process'

type Check = {
  readonly tool: string
  /** 体检动作：成功返回提示文本，失败返回 undefined。 */
  readonly probe: () => string | undefined
  /** 构建链工具缺席即整体失败；agent 只警告。 */
  readonly fatal: boolean
}

const version = (command: string, args: readonly string[] = ['--version']): string | undefined => {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: true })

  return result.status === 0 ? result.stdout.trim() : undefined
}

const CHECKS: readonly Check[] = [
  { tool: 'bun', probe: () => version('bun'), fatal: true },
  { tool: 'cargo', probe: () => version('cargo'), fatal: true },
  { tool: 'rustfmt', probe: () => version('rustfmt'), fatal: true },
  { tool: 'git', probe: () => version('git'), fatal: true },
  { tool: 'kimi', probe: () => version('kimi'), fatal: false },
]

let failed = false

for (const check of CHECKS) {
  const said = check.probe()

  if (said !== undefined) {
    process.stdout.write(`ok    ${check.tool}: ${said}\n`)
    continue
  }

  process.stdout.write(`${check.fatal ? 'FAIL' : 'warn'}  ${check.tool}: not found on PATH\n`)

  if (check.fatal) {
    failed = true
  }
}

if (failed) {
  process.stderr.write('doctor: build toolchain incomplete; see FAIL lines above\n')
  process.exit(1)
}
