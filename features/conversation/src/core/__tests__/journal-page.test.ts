import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@poietica/agent-model'
import { pageFromJournal } from '@poietica/feature-runs/core'

const at = '2026-11-08T00:00:00.000Z'

function turn(ordinal: number, text: string): AgentEvent[] {
  const turnId = `t${String(ordinal)}`
  const stepId = `${turnId}.1`
  const frameId = `${stepId}.f1`
  return [
    {
      type: 'run.started',
      durability: 'committed',
      schema: 1,
      at,
      runId: turnId,
      run: { kind: 'turn', turnId, ordinal, state: 'running', origin: { kind: 'user' }, prompt: text },
    },
    {
      type: 'step.started',
      durability: 'committed',
      schema: 1,
      at,
      turnId,
      step: { kind: 'step', stepId, turnId, ordinal: 1, state: 'running' },
    },
    {
      type: 'item.completed',
      durability: 'committed',
      schema: 1,
      at,
      turnId,
      stepId,
      frame: { kind: 'text', frameId, role: 'assistant', text: `答 ${text}` },
    },
    { type: 'run.completed', durability: 'committed', schema: 1, at, runId: turnId, outcome: 'completed' },
  ]
}

describe('pageFromJournal', () => {
  test('往前翻页按轮切，保留 hasMoreOlder', () => {
    const events = [...turn(1, '一'), ...turn(2, '二'), ...turn(3, '三')]
    const page = pageFromJournal(events, 't3', 1)
    expect(
      page?.items.filter((item) => item.kind === 'turn').map((item) => (item.kind === 'turn' ? item.turnId : '')),
    ).toEqual(['t2'])
    expect(page?.hasMoreOlder).toBe(true)
    const all = pageFromJournal(events, 't4', 20)
    expect(all?.items.filter((item) => item.kind === 'turn')).toHaveLength(3)
    expect(all?.hasMoreOlder).toBe(false)
  })

  test('头页可只覆盖最近记录，并带轮次目录', () => {
    const page = pageFromJournal([...turn(2, '二'), ...turn(3, '三')], null, 1)
    expect(
      page?.items.filter((item) => item.kind === 'turn').map((item) => (item.kind === 'turn' ? item.turnId : '')),
    ).toEqual(['t3'])
    expect(page?.hasMoreOlder).toBe(true)
    expect(page?.outline?.map((entry) => entry.turnId)).toEqual(['t2', 't3'])
  })

  test('长会话：1000 轮的头页折叠保持在预算内', () => {
    const events = Array.from({ length: 1000 }, (_, i) => turn(i + 1, `第 ${i + 1} 轮`)).flat()
    const started = performance.now()
    const page = pageFromJournal(events, null)
    const elapsed = performance.now() - started
    expect(page?.items.filter((item) => item.kind === 'turn')).toHaveLength(20)
    expect(page?.outline).toHaveLength(1000)
    /* 本机实测远低于 150ms；留余量给并行测试的调度抖动。 */
    expect(elapsed).toBeLessThan(500)
  })

  test('记录不是从第 1 轮开始 / 还没覆盖到请求页时回退', () => {
    expect(pageFromJournal(turn(2, '二'), 't2')).toBeNull()
    expect(pageFromJournal([], 't2')).toBeNull()
    expect(pageFromJournal(turn(1, '一'), 't9')).toBeNull()
  })
})
