import type { ConversationService, TurnSettled } from '@poietica/feature-conversation/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, type Clock, createId, type Disposable, type Logger } from '@poietica/foundation'
import type { Automation, AutomationRun } from '../contract/entities'
import { automationsErrors } from '../contract/errors'
import type { AutomationsRepository } from './repository'

/** 运行开始后每隔这么久问一次会话状态，把 awaiting 与 running 的切换写回运行记录 */
const AWAITING_POLL_MS = 5_000

export interface Runner {
  start(a: Automation, trigger: 'schedule' | 'manual', scheduledFor: number | null): Promise<AutomationRun>
  /** 由 index.ts 订阅 conversation 的 turnSettled 后转进来 */
  onTurnSettled(e: TurnSettled): void
  cancel(runId: string): Promise<void>
  isRunning(automationId: string): boolean
  dispose(): void
}

export function threadTitleOf(automation: Automation, at: number): string {
  const d = new Date(at)
  const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
    d.getHours(),
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `定时任务：${automation.title} ${stamp}`
}

const OUTCOME_OF: Readonly<Record<TurnSettled['outcome'], AutomationRun['outcome']>> = {
  completed: 'succeeded',
  cancelled: 'cancelled',
  failed: 'failed',
}

export function createRunner(d: {
  readonly repo: AutomationsRepository
  readonly conversation: ConversationService
  readonly workspaces: WorkspacesService
  readonly clock: Clock
  readonly logger: Logger
  readonly emitRunUpdated: (run: AutomationRun) => void
}): Runner {
  const { clock, conversation, logger, repo, workspaces } = d
  const polls = new Map<string, Disposable>()

  const stopPolling = (runId: string): void => {
    polls.get(runId)?.dispose()
    polls.delete(runId)
  }

  const publish = (run: AutomationRun): void => {
    repo.updateRun(run)
    d.emitRunUpdated(run)
  }

  const fail = (run: AutomationRun, message: string): AutomationRun => {
    stopPolling(run.id)
    const failed: AutomationRun = { ...run, outcome: 'failed', message, settledAt: clock.now() }
    publish(failed)
    repo.setIssue(run.automationId, message, clock.now())
    return failed
  }

  /** 运行开始后每 5 秒校对一次会话状态：awaiting ↔ running 都写回运行记录 */
  const watchAwaiting = (runId: string, threadId: string): void => {
    if (polls.has(runId)) return
    polls.set(
      runId,
      clock.setInterval(() => {
        const current = repo.getRun(runId)
        if (current === null || (current.outcome !== 'running' && current.outcome !== 'awaiting')) {
          stopPolling(runId)
          return
        }
        const thread = conversation.get(threadId)
        if (thread === null) return
        const next: AutomationRun['outcome'] = thread.state === 'awaiting' ? 'awaiting' : 'running'
        if (next !== current.outcome) publish({ ...current, outcome: next })
      }, AWAITING_POLL_MS),
    )
  }

  return {
    async start(a, trigger, scheduledFor) {
      if (repo.openRun(a.id) !== null) {
        throw new AppError(automationsErrors.already_running, '这个任务正在运行')
      }
      const startedAt = clock.now()
      let workspaceId: string
      try {
        workspaces.requireUsable(a.workspaceId)
        workspaceId = a.workspaceId
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const run: AutomationRun = {
          id: createId(),
          automationId: a.id,
          threadId: null,
          trigger,
          scheduledFor,
          startedAt,
          settledAt: null,
          outcome: 'running',
          message: null,
        }
        repo.insertRun(run)
        repo.trimRuns(a.id)
        logger.warn('automation workspace unavailable', { automationId: a.id, error: message })
        return fail(run, message)
      }

      /* 工作区可用：清掉上一次留下的 issue，这一次运行起新一轮 */
      repo.setIssue(a.id, null, startedAt)
      const thread = conversation.createThread({
        workspaceId,
        title: threadTitleOf(a, startedAt),
        origin: 'automation',
        posture: a.posture,
        model: a.model,
        thinking: a.thinking,
      })
      const run: AutomationRun = {
        id: createId(),
        automationId: a.id,
        threadId: thread.id,
        trigger,
        scheduledFor,
        startedAt,
        settledAt: null,
        outcome: 'running',
        message: null,
      }
      repo.insertRun(run)
      repo.trimRuns(a.id)
      try {
        await conversation.submit({ threadId: thread.id, text: a.prompt })
      } catch (e) {
        return fail(run, e instanceof Error ? e.message : String(e))
      }
      publish(run)
      watchAwaiting(run.id, thread.id)
      return run
    },
    onTurnSettled(e) {
      const open = repo.openRunsByThread(e.threadId)
      if (open.length === 0) return
      const settledAt = clock.now()
      for (const run of open) {
        stopPolling(run.id)
        publish({
          ...run,
          outcome: OUTCOME_OF[e.outcome],
          message: e.outcome === 'failed' ? (e.error?.message ?? '运行失败') : null,
          settledAt,
        })
      }
    },
    async cancel(runId) {
      const run = repo.getRun(runId)
      if (run === null) {
        throw new AppError(automationsErrors.run_not_found, '运行记录不存在')
      }
      if (run.threadId === null) return
      await conversation.cancel(run.threadId)
    },
    isRunning(automationId) {
      return repo.openRun(automationId) !== null
    },
    dispose() {
      for (const poll of polls.values()) poll.dispose()
      polls.clear()
    },
  }
}
