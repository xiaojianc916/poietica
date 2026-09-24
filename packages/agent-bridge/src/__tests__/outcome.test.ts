/*
 * 结局分类的自检：厂商报错不能被说成一轮成功。
 *
 * 这一格是「屏幕上有没有错误」的唯一产地，判据来自上游的 stopReason，所以逐条钉住。
 */

import { describe, expect, it } from 'bun:test'

import { outcomeOf } from '../outcome.ts'

describe('一轮的结局', () => {
  it('厂商报错落 failed，并把那句话原样带出去', () => {
    expect(outcomeOf({ stopReason: 'error', errorMessage: '403 forbidden' })).toEqual({
      kind: 'failed',
      message: '403 forbidden',
    })
  })

  it('被停掉落 cancelled，不是 failed —— 取消不伪装成失败', () => {
    expect(outcomeOf({ stopReason: 'aborted' })).toEqual({ kind: 'cancelled' })
  })

  it('正常收尾落 completed', () => {
    expect(outcomeOf({ stopReason: 'stop' })).toEqual({ kind: 'completed' })
    expect(outcomeOf({ stopReason: 'toolUse' })).toEqual({ kind: 'completed' })
  })

  it('没有消息时不凭空报失败', () => {
    expect(outcomeOf(undefined)).toEqual({ kind: 'completed' })
  })

  it('上游的静默中止不算失败：它后面还会接着跑', () => {
    /* 标记的正本是 @oh-my-pi/pi-tui 的 chat/messages.ts 的 SILENT_ABORT_MARKER。 */
    expect(outcomeOf({ stopReason: 'aborted', errorMessage: '__omp.silent_abort__' })).toEqual({
      kind: 'completed',
    })
  })
})
