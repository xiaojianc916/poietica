import type { AgentEvent } from '@poietica/agent-model'
import {
  CHECKPOINT_STEP_LABEL,
  CHECKPOINT_TURN_END_LABEL,
  type CheckpointService,
} from '@poietica/feature-checkpoints/core-api'
import type { JournalService } from '@poietica/feature-journal/core-api'
import type { Logger } from '@poietica/foundation'

interface ThreadLookup {
  get(threadId: string): { readonly workspaceId: string } | null
}

interface WorkspaceLookup {
  get(workspaceId: string): { readonly path: string } | null
}

export interface CheckpointSchedulerDeps {
  readonly threads: ThreadLookup
  readonly workspaces: WorkspaceLookup
  readonly checkpoints: CheckpointService
  readonly journal: Pick<JournalService, 'append'>
  readonly logger: Logger
}

export interface CheckpointScheduler {
  /** 轮次结束的收口点。 */
  atTurnEnd(threadId: string): void
  /** 每个模型步骤结束后的增量点。 */
  atStep(p: { readonly threadId: string; readonly stepId: string }): void
}

/**
 * 把「什么时候打检查点」从 conversation 的组合根里拆出来：轮次结束与每个步骤结束。
 * 打点失败只记 warn，不挡轮次收口；打点成功再把 checkpoint.created 写进 Journal。
 */
export function createCheckpointScheduler(d: CheckpointSchedulerDeps): CheckpointScheduler {
  const workspaceRootOf = (threadId: string): string | null => {
    const thread = d.threads.get(threadId)
    if (thread === null) return null
    return d.workspaces.get(thread.workspaceId)?.path ?? null
  }

  const journalCheckpoint = (
    threadId: string,
    checkpointId: string,
    workspaceRoot: string,
    label: string,
    reason: 'turn_end' | 'step',
    itemId?: string,
  ): void => {
    const event: AgentEvent = {
      schema: 1,
      at: new Date().toISOString(),
      durability: 'committed',
      type: 'checkpoint.created',
      checkpointId,
      workspaceRoot,
      label,
      reason,
      ...(itemId === undefined ? {} : { itemId }),
    }
    try {
      d.journal.append(threadId, 'main', [event])
    } catch (error) {
      d.logger.warn('checkpoint event not journaled', { threadId, error: String(error) })
    }
  }

  return {
    atTurnEnd(threadId) {
      const workspaceRoot = workspaceRootOf(threadId)
      if (workspaceRoot === null) return
      void d.checkpoints
        .create({ workspaceRoot, threadId, label: CHECKPOINT_TURN_END_LABEL })
        .then((checkpoint) =>
          journalCheckpoint(threadId, checkpoint.id, workspaceRoot, CHECKPOINT_TURN_END_LABEL, 'turn_end'),
        )
        .catch((error: unknown) => {
          d.logger.warn('turn end checkpoint failed', { threadId, error: String(error) })
        })
    },
    atStep(p) {
      const workspaceRoot = workspaceRootOf(p.threadId)
      if (workspaceRoot === null) return
      void d.checkpoints
        .create({ workspaceRoot, threadId: p.threadId, stepId: p.stepId, label: CHECKPOINT_STEP_LABEL })
        .then((checkpoint) =>
          journalCheckpoint(p.threadId, checkpoint.id, workspaceRoot, CHECKPOINT_STEP_LABEL, 'step', p.stepId),
        )
        .catch((error: unknown) => {
          d.logger.warn('step checkpoint failed', { threadId: p.threadId, stepId: p.stepId, error: String(error) })
        })
    },
  }
}
