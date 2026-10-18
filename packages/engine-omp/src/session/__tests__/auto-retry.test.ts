import '../../__tests__/omp-home'
import { describe, expect, test } from 'bun:test'
import type { EngineSessionEvent } from '@poietica/engine'
import { applyOps, emptyTimeline, type RetryNotice, retryNoticeOf } from '@poietica/transcript'
import { fakeOmpSession } from '../../projector/__tests__/fixtures/omp-session'

/*
 * 自动重试上屏（`auto_retry_start` / `auto_retry_end` → 同一个 notice 帧原地改写）。
 *
 * omp 在服务商抖动时会自己重试；不接上屏，那几十秒在人是「卡住了」。
 * 一次重试过程只占一格：次数原地往上走，每次请求的报错按先后记下，收口落回同一格。
 */

interface RetryCell {
  readonly frameId: string
  readonly level: string
  readonly message: string
  readonly retry: RetryNotice | null
}

function retryCellsOf(events: readonly EngineSessionEvent[]): RetryCell[] {
  const ops = events.flatMap((event) => (event.type === 'timeline' ? event.ops : []))
  const state = applyOps(emptyTimeline(), ops)
  const out: RetryCell[] = []
  for (const item of state.items) {
    if (item.kind !== 'turn') continue
    for (const step of item.steps)
      for (const frame of step.frames) {
        if (frame.kind !== 'notice') continue
        out.push({ frameId: frame.frameId, level: frame.level, message: frame.message, retry: retryNoticeOf(frame) })
      }
  }
  return out
}

async function submitted() {
  const fake = await fakeOmpSession()
  await fake.session.submit({ text: '发一句', images: [], files: [], skills: [], deliverAs: 'turn' })
  return fake
}

const start = (attempt: number, errorMessage: string) => ({
  type: 'auto_retry_start',
  attempt,
  maxAttempts: 5,
  delayMs: 1000,
  errorMessage,
})

describe('自动重试上屏', () => {
  test('同一次重试过程只占一格：次数原地往上走，报错按先后累积', async () => {
    const fake = await submitted()
    fake.feed(start(1, 'rate limited'))
    const first = retryCellsOf(fake.events)
    expect(first).toHaveLength(1)
    expect(first[0]?.level).toBe('warning')
    expect(first[0]?.message).toBe('正在重试 1/5')
    expect(first[0]?.retry).toEqual({ state: 'running', attempt: 1, maxAttempts: 5, errors: ['rate limited'] })

    fake.feed(start(2, 'overloaded'))
    const second = retryCellsOf(fake.events)
    expect(second).toHaveLength(1)
    expect(second[0]?.frameId).toBe(first[0]?.frameId ?? '')
    expect(second[0]?.retry).toEqual({
      state: 'running',
      attempt: 2,
      maxAttempts: 5,
      errors: ['rate limited', 'overloaded'],
    })
  })

  test('成功：同一格落成 recovered（界面据此收起）', async () => {
    const fake = await submitted()
    fake.feed(start(1, 'rate limited'))
    fake.feed({ type: 'auto_retry_end', success: true, attempt: 1 })
    const cells = retryCellsOf(fake.events)
    expect(cells).toHaveLength(1)
    expect(cells[0]?.retry?.state).toBe('recovered')
    expect(cells[0]?.retry?.errors).toEqual(['rate limited'])
  })

  test('次数用完：最后那次的报错接在末尾，整格是 error', async () => {
    const fake = await submitted()
    for (let attempt = 1; attempt <= 5; attempt += 1) fake.feed(start(attempt, `boom ${String(attempt)}`))
    fake.feed({ type: 'auto_retry_end', success: false, attempt: 5, finalError: 'boom 6' })
    const cells = retryCellsOf(fake.events)
    expect(cells).toHaveLength(1)
    expect(cells[0]?.level).toBe('error')
    expect(cells[0]?.message).toBe('重试 5 次仍失败：boom 6')
    expect(cells[0]?.retry).toEqual({
      state: 'failed',
      attempt: 5,
      maxAttempts: 5,
      errors: ['boom 1', 'boom 2', 'boom 3', 'boom 4', 'boom 5', 'boom 6'],
    })
  })

  test('人按了停止：落成 cancelled，「Retry cancelled」不当报错记', async () => {
    const fake = await submitted()
    fake.feed(start(1, 'rate limited'))
    fake.feed({ type: 'auto_retry_end', success: false, attempt: 1, finalError: 'Retry cancelled' })
    const cells = retryCellsOf(fake.events)
    expect(cells[0]?.message).toBe('已停止重试')
    expect(cells[0]?.retry).toEqual({ state: 'cancelled', attempt: 1, maxAttempts: 5, errors: ['rate limited'] })
  })

  test('服务商要求的等待超过上限：那句换成中文，原始报错照抄', async () => {
    const fake = await submitted()
    fake.feed({
      type: 'auto_retry_end',
      success: false,
      attempt: 1,
      finalError: 'Provider requested 7200000ms wait, exceeds retry.maxDelayMs (300000ms). Original error: 429 quota',
    })
    const cells = retryCellsOf(fake.events)
    expect(cells).toHaveLength(1)
    expect(cells[0]?.retry?.state).toBe('failed')
    expect(cells[0]?.retry?.errors).toEqual([
      '服务商要求等待 2 小时，超过重试间隔上限（5 分钟），不再重试。原始报错：429 quota',
    ])
  })

  test('没见过开头的成功不上屏', async () => {
    const fake = await submitted()
    fake.feed({ type: 'auto_retry_end', success: true, attempt: 2 })
    expect(retryCellsOf(fake.events)).toHaveLength(0)
  })

  test('轮终时还开着：由轮终收口，不留一格一直在转', async () => {
    const fake = await submitted()
    fake.feed(start(1, 'rate limited'))
    fake.feed({ type: 'agent_end' })
    const cells = retryCellsOf(fake.events)
    expect(cells).toHaveLength(1)
    expect(cells[0]?.retry?.state).not.toBe('running')
  })

  test('收口之后再出错：另起一格，不改写上一格', async () => {
    const fake = await submitted()
    fake.feed(start(1, 'rate limited'))
    fake.feed({ type: 'auto_retry_end', success: true, attempt: 1 })
    fake.feed(start(1, 'overloaded'))
    const cells = retryCellsOf(fake.events)
    expect(cells).toHaveLength(2)
    expect(cells[0]?.retry?.state).toBe('recovered')
    expect(cells[1]?.retry).toEqual({ state: 'running', attempt: 1, maxAttempts: 5, errors: ['overloaded'] })
  })
})
