import { expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type RetryNotice, type TranscriptOperation } from '@poietica/transcript'
import type { TranscriptPage } from '../../../shared/model/transcript'
import { createProjectionMemo, projectTranscript } from '../transcript-projector'

/*
 * 自动重试那一格（notice 帧，source = auto_retry，进展在 detail.retry）投影成 retry 条目：
 * 成功了不上屏；用尽时这一轮的报错（「Retry budget exhausted…」）是同一件事，不再另起一行。
 */

const AT = '2026-10-10T00:00:00.000Z'

function pageWith(o: { readonly retry?: RetryNotice; readonly error?: string }): TranscriptPage {
  const ops = [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: 't1',
        ordinal: 1,
        state: o.error === undefined ? 'completed' : 'failed',
        origin: { kind: 'user' },
        prompt: '发一句',
        startedAt: AT,
        endedAt: AT,
        ...(o.error === undefined ? {} : { error: o.error }),
      },
    },
    {
      op: 'step.upsert',
      turnId: 't1',
      step: { kind: 'step', stepId: 't1:s0', turnId: 't1', ordinal: 0, state: 'completed', startedAt: AT, endedAt: AT },
    },
    ...(o.retry === undefined
      ? []
      : [
          {
            op: 'frame.upsert',
            turnId: 't1',
            stepId: 't1:s0',
            frame: {
              kind: 'notice',
              frameId: 't1:s0:f0',
              level: o.retry.state === 'failed' ? 'error' : 'warning',
              message: '正在重试 1/5',
              source: 'auto_retry',
              detail: { retry: o.retry },
            },
          },
        ]),
  ] as unknown as TranscriptOperation[]
  const state = applyOps(emptyTimeline(), ops)
  return {
    ...state,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
    agentId: 'main',
    agents: [],
    pendingInteractions: [],
    seq: 1,
  } as unknown as TranscriptPage
}

const itemsOf = (page: TranscriptPage) =>
  projectTranscript(page, createProjectionMemo()).active.items.filter(
    (item) => item.type === 'retry' || item.type === 'error',
  )

test('R1 在重试：一条 retry 条目，次数与报错原样带过来', () => {
  const retry: RetryNotice = { state: 'running', attempt: 2, maxAttempts: 5, errors: ['rate limited', 'overloaded'] }
  expect(itemsOf(pageWith({ retry }))).toEqual([
    expect.objectContaining({ type: 'retry', state: 'running', attempt: 2, maxAttempts: 5, errors: retry.errors }),
  ])
})

test('R2 重试成功：那一格不上屏', () => {
  const retry: RetryNotice = { state: 'recovered', attempt: 1, maxAttempts: 5, errors: ['rate limited'] }
  expect(itemsOf(pageWith({ retry }))).toEqual([])
})

test('R3 用尽：只剩重试那一行，这一轮的报错不再另起一行', () => {
  const retry: RetryNotice = { state: 'failed', attempt: 5, maxAttempts: 5, errors: ['a', 'a', 'a', 'a', 'a', 'b'] }
  const items = itemsOf(pageWith({ retry, error: 'Retry budget exhausted after 5 retries: b' }))
  expect(items).toHaveLength(1)
  expect(items[0]).toEqual(expect.objectContaining({ type: 'retry', state: 'failed', attempt: 5 }))
})

test('R4 别的报错照旧是报错行', () => {
  expect(itemsOf(pageWith({ error: 'boom' }))).toEqual([
    expect.objectContaining({ type: 'error', level: 'error', message: 'boom' }),
  ])
})
