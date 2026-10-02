/*
 * 宿主没有终端呈现面，这件事必须在桥上声明一次，否则 pty:true 会走进一条必炸的路。
 *
 * 起因是一次真实故障：bash({ command, pty:true }) 抛
 * `undefined is not an object (evaluating 'result.cancelled')`。链路是：SDK 的闸门
 * 只看 hasUI 与 ui 在不在场（tools/bash-pty-selection.ts:13），看不出我们的 UIContext
 * 画不了 overlay —— 它那一格以 undefined 兑现（approval.ts:371 的 `custom` 空实现）。
 * 于是 tools/bash.ts:1415 选中交互分支，`ui.custom` 立刻交回 undefined，
 * tools/bash.ts:1440 读 `result.cancelled` 当场 TypeError。
 *
 * 判据是「桥自己把 PI_NO_PTY 压成 1」，不是「上游怎么判」：后者是上游行为，会变 ——
 * 上游哪天把闸门收紧，这条断言仍该成立，因为事实是**我们没有终端**，不是上游恰好挡住。
 *
 * 自检跑法：bun test src/__tests__/pty-interactive-ability-is-declared-off.test.ts
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bridge = readFileSync(join(here, '..', 'bridge.ts'), 'utf8')

test('the bridge declares that no interactive terminal exists before any session opens', () => {
  /*
   * 必须逐字是 `process.env['PI_NO_PTY'] = '1'`：上游读的是 pi-utils 的 $env，
   * 而它就是 Bun.env，与 process.env 是同一个活对象（env.ts:323）。
   */
  expect(bridge).toContain("process.env['PI_NO_PTY'] = '1'")
})

test('the declaration sits with the other host-environment overrides, not inside a branch', () => {
  const pty = bridge.indexOf("process.env['PI_NO_PTY']")
  const notifications = bridge.indexOf("process.env['PI_NOTIFICATIONS']")

  expect(notifications).toBeGreaterThan(-1)
  /* 与另外两条宿主环境覆盖紧挨着：散开就会有一条被塞进某个分支里，那时它只在部分路径生效。 */
  expect(Math.abs(pty - notifications)).toBeLessThan(2000)
})
