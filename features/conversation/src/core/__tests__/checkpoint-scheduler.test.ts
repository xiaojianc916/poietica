import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@poietica/agent-model'
import type { CheckpointService } from '@poietica/feature-checkpoints/core-api'
import { createTestLogger, waitFor } from '@poietica/test-kit'
import { createCheckpointScheduler } from '../checkpoint-scheduler'

function harness() {
  const created: { threadId?: string; stepId?: string; label?: string; workspaceRoot: string }[] = []
  const journaled: AgentEvent[] = []
  const checkpoints: CheckpointService = {
    create: async (input) => {
      created.push(input)
      return {
        id: `cp-${created.length}`,
        workspaceRoot: input.workspaceRoot,
        createdAt: new Date(0).toISOString(),
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
        ...(input.label === undefined ? {} : { label: input.label }),
      }
    },
    list: async () => [],
    diff: async () => '',
    diffPaths: async () => [],
    diffNumstat: async () => [],
    changedPaths: async () => [],
    readFile: async () => null,
    restore: async (input) => ({ restored: input.paths }),
  }
  const scheduler = createCheckpointScheduler({
    threads: { get: (threadId) => (threadId === 't1' ? { workspaceId: 'w1' } : null) },
    workspaces: { get: (workspaceId) => (workspaceId === 'w1' ? { path: 'C:/ws' } : null) },
    checkpoints,
    journal: {
      append: (_threadId, _agentId, events) => {
        journaled.push(...events)
        return events.length
      },
    },
    logger: createTestLogger(),
  })
  return { scheduler, created, journaled }
}

describe('检查点调度', () => {
  test('步骤结束打增量点，并把 checkpoint.created(reason=step) 写进 Journal', async () => {
    const h = harness()
    h.scheduler.atStep({ threadId: 't1', stepId: 't1.3' })
    await waitFor(() => h.created.length === 1)
    expect(h.created[0]).toMatchObject({
      workspaceRoot: 'C:/ws',
      threadId: 't1',
      stepId: 't1.3',
      label: '步骤结束',
    })
    await waitFor(() => h.journaled.length === 1)
    expect(h.journaled[0]).toMatchObject({
      type: 'checkpoint.created',
      checkpointId: 'cp-1',
      reason: 'step',
      itemId: 't1.3',
    })
  })

  test('轮次结束打收口点；线程或工作区已删时是空操作', async () => {
    const h = harness()
    h.scheduler.atTurnEnd('t1')
    await waitFor(() => h.created.length === 1)
    expect(h.created[0]).toMatchObject({ label: '轮次结束', threadId: 't1' })
    await waitFor(() => h.journaled.length === 1)
    expect(h.journaled[0]).toMatchObject({ type: 'checkpoint.created', reason: 'turn_end' })

    h.scheduler.atStep({ threadId: 'gone', stepId: 'x' })
    h.scheduler.atTurnEnd('gone')
    expect(h.created).toHaveLength(1)
  })
})
