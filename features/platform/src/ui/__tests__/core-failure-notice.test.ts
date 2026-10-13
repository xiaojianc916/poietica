import { describe, expect, test } from 'bun:test'
import type { CoreStatus } from '@poietica/ui-kernel'
import { coreFailureVisible, FAILURE_TEXT } from '../core-failure-notice'

const status = (state: CoreStatus['state'], reason: CoreStatus['reason'] = null, attempt = 0): CoreStatus => ({
  state,
  reason,
  attempt,
})

/* 产品负责人 2026-10-06 的两次收缩，最终把 Core 状态横幅整条删掉：`restarting` 先删（Core 自己会重连）；`failed` 从横幅行移到**入口提示**
 * （见 core-failure-notice.tsx）；最后 `starting` / `stopped` 那档也删除 —— 它每次启动都会横贯整窗闪一下，退出时还留下一条没有字的
 * `--ui-accent` 色块。于是 Failed 文案表与可见性判据全部收在 core-failure-notice 这一份里。 */
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
