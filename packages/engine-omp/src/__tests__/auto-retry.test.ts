import './omp-home'
import { describe, expect, test } from 'bun:test'
import type { EngineSessionEvent } from '@poietica/engine'
import { applyOps, emptyTimeline } from '@poietica/transcript'
import { fakeOmpSession } from '../projector/__tests__/fixtures/omp-session'

/*
 * 自动重试上屏（12 页 §9.1 的表：`auto_retry_start` / `auto_retry_end` → notice 帧）。
 *
 * omp 在服务商抖动时会自己重试；不把这两条接上屏，那几十秒在人是「卡住了」——
 * 时间线上一个字节都不长，看起来像崩了。
 */

function noticesOf(events: readonly EngineSessionEvent[]): { level: string; message: string }[] {
  const ops = events.flatMap((event) => (event.type === 'timeline' ? event.ops : []))
  const state = applyOps(emptyTimeline(), ops)
  const out: { level: string; message: string }[] = []
  for (const item of state.items) {
    if (item.kind !== 'turn') continue
    for (const step of item.steps)
      for (const frame of step.frames) {
        if (frame.kind === 'notice') out.push({ level: frame.level, message: frame.message })
      }
  }
  return out
}

describe('自动重试上屏', () => {
  test('retry_start 上一条 warning notice，写清第几次重试与原因', async () => {
    const fake = await fakeOmpSession()
    await fake.session.submit({ text: '发一句', images: [], files: [], skills: [], deliverAs: 'turn' })
    fake.feed({
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 5,
      delayMs: 1000,
      errorMessage: 'rate limited',
    })

    const notices = noticesOf(fake.events)
    expect(notices.length).toBe(1)
    expect(notices[0]?.level).toBe('warning')
    expect(notices[0]?.message).toContain('2/5')
    expect(notices[0]?.message).toContain('rate limited')
  })

  test('retry_end 成功不上屏、失败是 error', async () => {
    const ok = await fakeOmpSession()
    await ok.session.submit({ text: '发一句', images: [], files: [], skills: [], deliverAs: 'turn' })
    ok.feed({ type: 'auto_retry_end', success: true, attempt: 2 })
    expect(noticesOf(ok.events).length).toBe(0)

    const bad = await fakeOmpSession()
    await bad.session.submit({ text: '发一句', images: [], files: [], skills: [], deliverAs: 'turn' })
    bad.feed({ type: 'auto_retry_end', success: false, attempt: 5, finalError: 'boom' })
    const last = noticesOf(bad.events).at(-1)
    expect(last?.level).toBe('error')
    expect(last?.message).toContain('boom')
  })
})
