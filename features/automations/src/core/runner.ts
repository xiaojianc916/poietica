import type {
  ConversationService,
  SubmissionFailed,
  ThreadRemoved,
  TurnSettled,
} from '@poietica/feature-conversation/core-api'
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
  /** 一句话没送达（R-06）：本次运行不会再有回合结束事件，就地收成 failed */
  onSubmissionFailed(e: SubmissionFailed): void
  /** 运行所在的对话被删除（R-06）：收成 cancelled（不是失败，不挂 issue） */
  onThreadRemoved(e: ThreadRemoved): void
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

  /** 按运行号读还开着的那条运行（running / awaiting）；其余一律是 null（repo.openRun 是按任务号查） */
  const openRunById = (runId: string): AutomationRun | null => {
    const run = repo.getRun(runId)
    if (run === null) return null
    return run.outcome === 'running' || run.outcome === 'awaiting' ? run : null
  }

  const fail = (run: AutomationRun, message: string): AutomationRun => {
    stopPolling(run.id)
    const failed: AutomationRun = { ...run, outcome: 'failed', message, settledAt: clock.now() }
    publish(failed)
    repo.setIssue(run.automationId, message, clock.now())
    return failed
  }

  /**
   * 运行开始后每 5 秒校对一次会话状态：只负责 awaiting ↔ running。
   *
   * `idle` **不是**「运行中」的证据（R-06）：一轮还没开出来的失败由 submissionFailed 事件
   * 负责收口，轮终由 turnSettled 负责 —— 轮询把它当成 running 的话，一条永不结束的
   * open run 就永远没人收，调度器从此跳过这个任务。
   */
  const watchAwaiting = (runId: string, threadId: string): void => {
    if (polls.has(runId)) return
    const poll = (): void => {
      const current = openRunById(runId)
      if (current === null) {
        stopPolling(runId)
        return
      }
      const thread = conversation.get(threadId)
      /* idle 与「对话读不到」都不动它：收口归事件，轮询只搬 running ↔ awaiting */
      if (thread === null || thread.state === 'idle') return
      const next: AutomationRun['outcome'] = thread.state === 'awaiting' ? 'awaiting' : 'running'
      if (next !== current.outcome) publish({ ...current, outcome: next })
    }
    polls.set(runId, clock.setInterval(poll, AWAITING_POLL_MS))
  }

  /** 起一条新运行记录（工作区不可用时 threadId 为 null） */
  const insertRun = (
    a: Automation,
    trigger: 'schedule' | 'manual',
    scheduledFor: number | null,
    threadId: string | null,
    startedAt: number,
  ): AutomationRun => {
    const run: AutomationRun = {
      id: createId(),
      automationId: a.id,
      threadId,
      trigger,
      scheduledFor,
      startedAt,
      settledAt: null,
      outcome: 'running',
      message: null,
    }
    repo.insertRun(run)
    repo.trimRuns(a.id)
    return run
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
        logger.warn('automation workspace unavailable', { automationId: a.id, error: message })
        return fail(insertRun(a, trigger, scheduledFor, null, startedAt), message)
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
      const run = insertRun(a, trigger, scheduledFor, thread.id, startedAt)
      try {
        await conversation.submit({ threadId: thread.id, text: a.prompt })
      } catch (e) {
        return fail(run, e instanceof Error ? e.message : String(e))
      }
      /*
       * 交接失败的事件可能先于 `submit()` 的 await 返回（R-06 §3.3）：这时运行已经被
       * onSubmissionFailed 收成了 failed，这里再 publish 一次会把结局覆盖回 running。
       * 所以重新读库，只有还开着的运行才接着等轮终（库里的行没了就退回手里这一份）。
       */
      const current = openRunById(run.id)
      if (current === null) return repo.getRun(run.id) ?? run
      publish(current)
      watchAwaiting(run.id, thread.id)
      return current
    },
    onSubmissionFailed(e) {
      /* 用户在运行中插的话失败不该让这次运行失败 —— 只有 turn 方式才代表「这句话没开始」 */
      if (e.deliverAs !== 'turn') return
      for (const run of repo.openRunsByThread(e.threadId)) {
        fail(run, `没能开始运行：${e.error.message}`)
      }
    },
    onThreadRemoved(e) {
      for (const run of repo.openRunsByThread(e.threadId)) {
        /* 对话被删不是任务出问题：收成 cancelled，也不在任务卡片上挂 issue */
        stopPolling(run.id)
        publish({
          ...run,
          outcome: 'cancelled',
          message: '运行所在的对话已被删除',
          settledAt: clock.now(),
        })
      }
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
