import { describe, expect, test } from 'bun:test'
import type { CoreStatus } from '@poietica/ui-kernel'
import { coreFailureVisible, FAILURE_TEXT } from '../core-failure-notice'

const status = (state: CoreStatus['state'], reason: CoreStatus['reason'] = null, attempt = 0): CoreStatus => ({
  state,
  reason,
  attempt,
})

/*
 * 产品负责人 2026-10-06 的两次收缩，最终把 Core 状态横幅整条删掉：
 *   - `restarting`（「Agent 引擎意外退出，正在重新连接（第 N 次）」）先删 —— Core 自己会重连，
 *     报在屏幕顶上只会让人以为出了事；
 *   - `failed`（要人重新启动的那一档）从横幅行移到**入口提示**，与「还没有配置任何模型
 *     服务商」同一个样式、同一个位置（吉祥物上方）；
 *   - 最后 `starting` / `stopped` 那档「正在启动 Agent 引擎…」也删除（见 platform/ui/index.tsx
 *     的注释）：它每次启动都会横贯整窗闪一下，退出时还留下一条没有字的 `--ui-accent` 色块。
 *
 * 于是 Failed 文案表与可见性判据全部收在 core-failure-notice 这一份里，外壳横幅区不再有
 * platform 的贡献。
 */
describe('入口提示：Core 起不来', () => {
  test('只有 failed 占这一格', () => {
    expect(coreFailureVisible(status('starting'))).toBe(false)
    expect(coreFailureVisible(status('restarting', 'crashed', 2))).toBe(false)
    expect(coreFailureVisible(status('ready'))).toBe(false)
    expect(coreFailureVisible(status('stopped'))).toBe(false)
    expect(coreFailureVisible(status('failed', null))).toBe(true)
  })

  test('八个 reason 全覆盖', () => {
    expect(Object.keys(FAILURE_TEXT).sort()).toEqual([
      'bad_arguments',
      'core_missing',
      'crash_loop',
      'data_too_new',
      'isolation_violated',
      'protocol_mismatch',
      'start_failed',
      'start_timeout',
    ])
  })
})
