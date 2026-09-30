/*
 * 桥的 stdout 是协议通道：除了一行一条 JSON，任何字节都不许落进去。
 *
 * 起因是一次真实故障：ask 工具等人答题时会发一次终端通知
 * （tools/ask.ts 的 `#sendAskNotification`，`ask.notify` 默认 on），而 omp 的
 * `TERMINAL.sendNotification` 直接 `process.stdout.write` 一段 BEL / OSC 转义序列 ——
 * 它不带换行，于是粘在下一条 JSON 行前面，对端 `wire::decode` 当场解不开。
 *
 * 判据是「桥自己把那个开关压掉了」，不是「运行时不发通知」：后者是上游行为，会变。
 * 官方 RPC 模式对同一件事写下了同一句（modes/rpc/rpc-mode.ts:817-821）。
 *
 * 自检跑法：bun test src/__tests__/stdout-is-a-protocol-channel.test.ts
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bridge = readFileSync(join(here, '..', 'bridge.ts'), 'utf8')

test('the bridge suppresses terminal notifications before any session opens', () => {
  /*
   * 必须逐字是 `process.env['PI_NOTIFICATIONS'] = 'off'`：上游读的是 pi-utils 的 $env，
   * 而它与 process.env 是同一个活对象（env.ts 的 `export const $env = Bun.env`）。
   */
  expect(bridge).toContain("process.env['PI_NOTIFICATIONS'] = 'off'")
})

test('the suppression sits with the other host-environment overrides, not inside a branch', () => {
  const suppression = bridge.indexOf("process.env['PI_NOTIFICATIONS']")
  const titleSuppression = bridge.indexOf("process.env['PI_NO_TITLE']")

  expect(titleSuppression).toBeGreaterThan(-1)
  /* 两条宿主环境覆盖紧挨着：散开就会有一条被塞进某个分支里，那时它只在部分路径生效。 */
  expect(Math.abs(suppression - titleSuppression)).toBeLessThan(2000)
})
