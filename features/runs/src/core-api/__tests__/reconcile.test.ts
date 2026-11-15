import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@poietica/agent-model'
import { createTestLogger, fakeClock } from '@poietica/test-kit'
import { reconcileInterruptedRuns } from '../reconcile'

function started(runId: string): AgentEvent {
  return {
    type: 'run.started',
    schema: 1,
    at: '2026-01-01T00:00:00.000Z',
    durability: 'committed',
    runId,
    run: { kind: 'turn', turnId: runId, ordinal: 1, state: 'running', origin: { kind: 'user' } },
  }
}

function completed(runId: string): AgentEvent {
  return {
    type: 'run.completed',
    schema: 1,
    at: '2026-01-01T00:00:01.000Z',
    durability: 'committed',
    runId,
    outcome: 'completed',
  }
}

describe('启动对账：中断的 Run', () => {
  test('只有 run.started 的轮补成 interrupted；重复对账不重复补', async () => {
    const byThread = new Map<string, AgentEvent[]>([
      ['t1', [started('r1')]],
      ['t2', [started('r2'), completed('r2')]],
    ])
    const appended: { threadId: string; events: readonly AgentEvent[] }[] = []
    const journal = {
      readTyped: (threadId: string) => byThread.get(threadId) ?? [],
      append: (threadId: string, _agentId: string, events: readonly AgentEvent[]) => {
        appended.push({ threadId, events })
        byThread.set(threadId, [...(byThread.get(threadId) ?? []), ...events])
        return events.length
      },
    }
    const common = { journal, clock: fakeClock(), logger: createTestLogger() }
    expect(await reconcileInterruptedRuns({ ...common, threadIds: ['t1', 't2'] })).toBe(1)
    expect(appended).toHaveLength(1)
    expect(appended[0]?.threadId).toBe('t1')
    expect(appended[0]?.events[0]).toMatchObject({
      type: 'run.completed',
      runId: 'r1',
      outcome: 'interrupted',
    })
    expect(await reconcileInterruptedRuns({ ...common, threadIds: ['t1', 't2'] })).toBe(0)
  })
})
