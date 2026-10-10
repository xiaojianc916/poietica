import type {
  ConversationService,
  SubmissionFailed,
  ThreadRemoved,
  TurnSettled,
} from '@poietica/feature-conversation/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, type Clock, createId, type Disposable, type Logger } from '@poietica/foundation'
import type { Automation, AutomationAttention, AutomationRun, RunTrigger } from '../contract/entities'
import { automationsErrors } from '../contract/errors'
import { noticeOf } from './notice'
import type { AutomationsRepository } from './repository'
import { wallTime } from './time'

/** 运行开始后每隔这么久问一次会话状态：搬 awaiting ↔ running、累计运行时长、看两条超时 */
const AWAITING_POLL_MS = 5_000
/** 单次运行最多跑多久（只算真在跑的时间，等批准的时间不算）—— 审查 R-14 */
export const RUN_TIMEOUT_MS = 60 * 60_000
/** 卡在等批准上最多等多久 —— 审查 R-14 */
export const APPROVAL_TIMEOUT_MS = 2 * 60 * 60_000

export const RUN_TIMEOUT_MESSAGE = '运行超过 60 分钟，已停止'
export const APPROVAL_TIMEOUT_MESSAGE = '等待批准超过 2 小时，已停止本次运行'
export const BUSY_THREAD_MESSAGE = '续用的对话正在进行中，这一次跳过'

export interface Runner {
  start(a: Automation, trigger: RunTrigger, scheduledFor: number | null): Promise<AutomationRun>
  /** 到点了但不跑：记一条 skipped（上一次还没结束 / 应用当时没开且不补跑 / 续用的对话正忙） */
  skip(a: Automation, trigger: RunTrigger, scheduledFor: number | null, message: string): AutomationRun
  /** 运行中的 agent 交结论（automation_report）；这条对话上没有开着的运行 → not_in_run */
  report(threadId: string, summary: string, attention: boolean): AutomationRun[]
  /** 由 index.ts 订阅 conversation 的 turnSettled 后转进来 */
  onTurnSettled(e: TurnSettled): void
  /** 一句话没送达（R-06）：本次运行不会再有回合结束事件，就地收成 failed */
  onSubmissionFailed(e: SubmissionFailed): void
  /** 运行所在的对话被删除（R-06）：收成 cancelled */
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

/** 运行结束前交结论的那句交代：与 agent-tools.ts 的 automation_report 同名同参 */
export const REPORT_INSTRUCTION =
  '（运行结束前调用 automation_report，用一两句话写下结论；需要用户处理或有异常发现时把 attention 设为 true。）'

/**
 * 真正投给 agent 的那段话：一行抬头（哪个任务、为什么此刻在跑）+ 用户写的指令 + 交结论的交代。
 * 抬头让续用同一条对话的 agent 分得清「这是第几次、哪天的运行」；用户在对话里看到的也是这段。
 */
export function framePrompt(a: Automation, trigger: RunTrigger, scheduledFor: number | null): string {
  const when =
    trigger === 'manual' || scheduledFor === null
      ? '手动运行'
      : trigger === 'catch_up'
        ? `补跑（原定 ${wallTime(scheduledFor, a.schedule.timeZone)}，当时应用没有运行）`
        : `计划于 ${wallTime(scheduledFor, a.schedule.timeZone)}`
  return `【定时任务】${a.title} · ${when}\n\n${a.prompt}\n\n${REPORT_INSTRUCTION}`
}

const OUTCOME_OF: Readonly<Record<TurnSettled['outcome'], AutomationRun['outcome']>> = {
  completed: 'succeeded',
  cancelled: 'cancelled',
  failed: 'failed',
}

interface Watch {
  readonly timer: Disposable
  readonly threadId: string
  lastPollAt: number
  /** 真在跑（running）累计的毫秒数；等批准的时间不算 */
  activeMs: number
  /** 这一段等批准从什么时候开始；不在等批准是 null */
  awaitingSince: number | null
}

export function createRunner(d: {
  readonly repo: AutomationsRepository
  readonly conversation: ConversationService
  readonly workspaces: WorkspacesService
  readonly clock: Clock
  readonly logger: Logger
  readonly emitRunUpdated: (run: AutomationRun) => void
  readonly emitAttention: (attention: AutomationAttention) => void
  readonly emitChanged: () => void
}): Runner {
  const { clock, conversation, logger, repo, workspaces } = d
  const watches = new Map<string, Watch>()

  const stopWatching = (runId: string): void => {
    watches.get(runId)?.timer.dispose()
    watches.delete(runId)
  }

  const publish = (run: AutomationRun): void => {
    repo.updateRun(run)
    d.emitRunUpdated(run)
  }

  /** 按任务的通知策略决定要不要告诉用户（判定见 notice.ts） */
  const announce = (run: AutomationRun, moment: 'settled' | 'awaiting'): void => {
    const automation = repo.get(run.automationId)
    if (automation === null) return
    const notice = noticeOf(automation, run, moment)
    if (notice === null) return
    d.emitAttention({ automationId: run.automationId, runId: run.id, threadId: run.threadId, ...notice })
  }

  /** 按运行号读还开着的那条运行（running / awaiting）；其余一律是 null */
  const openRunById = (runId: string): AutomationRun | null => {
    const run = repo.getRun(runId)
    if (run === null) return null
    return run.outcome === 'running' || run.outcome === 'awaiting' ? run : null
  }

  /**
   * 收口一条运行：写结局、停轮询、按策略通知。
   *
   * 不再往任务上挂 issue（审查 R-14）：issue 只表示「计划本身有问题」，而 `due()` 只挑
   * issue 为空的任务 —— 一次送达失败就挂 issue 的话，这个任务从此不再被调度，直到重启或
   * 改一次任务。运行失败只记在运行记录里（列表上的「上次结果」就是它）。
   */
  const settle = (run: AutomationRun, outcome: AutomationRun['outcome'], message: string | null): AutomationRun => {
    stopWatching(run.id)
    const settled: AutomationRun = { ...run, outcome, message, settledAt: clock.now() }
    publish(settled)
    announce(settled, 'settled')
    return settled
  }

  /** 超时：先把运行收成 failed（之后的 turnSettled 找不到开着的运行，不会把它改写成 cancelled），再停会话 */
  const timeOut = (run: AutomationRun, message: string): void => {
    settle(run, 'failed', message)
    if (run.threadId === null) return
    conversation.cancel(run.threadId).catch((e: unknown) => {
      logger.warn('automation timeout cancel failed', { runId: run.id, error: String(e) })
    })
  }

  /** 等批准：这一段刚开始 → 通知一次；已经等满 2 小时 → 停 */
  const checkAwaiting = (w: Watch, run: AutomationRun, now: number): void => {
    if (w.awaitingSince === null) {
      w.awaitingSince = now
      announce(run, 'awaiting')
      return
    }
    if (now - w.awaitingSince >= APPROVAL_TIMEOUT_MS) timeOut(run, APPROVAL_TIMEOUT_MESSAGE)
  }

  /** 真在跑：把上一拍到这一拍的时间记进运行时长；满 60 分钟 → 停 */
  const checkRunning = (w: Watch, run: AutomationRun, elapsed: number): void => {
    w.awaitingSince = null
    w.activeMs += elapsed
    if (w.activeMs >= RUN_TIMEOUT_MS) timeOut(run, RUN_TIMEOUT_MESSAGE)
  }

  /** 运行记录搬到 running / awaiting（已经是就原样返回） */
  const moveTo = (run: AutomationRun, outcome: 'running' | 'awaiting'): AutomationRun => {
    if (run.outcome === outcome) return run
    const moved: AutomationRun = { ...run, outcome }
    publish(moved)
    return moved
  }

  /** 一拍：运行已收口就停表；会话在跑就搬状态、看超时 */
  const poll = (runId: string): void => {
    const w = watches.get(runId)
    const current = openRunById(runId)
    if (w === undefined || current === null) {
      stopWatching(runId)
      return
    }
    const now = clock.now()
    const elapsed = now - w.lastPollAt
    w.lastPollAt = now
    const state = conversation.get(w.threadId)?.state ?? 'idle'
    if (state === 'idle') return
    if (state === 'awaiting') checkAwaiting(w, moveTo(current, 'awaiting'), now)
    else checkRunning(w, moveTo(current, 'running'), elapsed)
  }

  const watch = (runId: string, threadId: string, startedAt: number): void => {
    if (watches.has(runId)) return
    watches.set(runId, {
      timer: clock.setInterval(() => poll(runId), AWAITING_POLL_MS),
      threadId,
      lastPollAt: startedAt,
      activeMs: 0,
      awaitingSince: null,
    })
  }

  const insertRun = (
    a: Automation,
    trigger: RunTrigger,
    scheduledFor: number | null,
    threadId: string | null,
    startedAt: number,
    closed: { outcome: 'skipped'; message: string } | null = null,
  ): AutomationRun => {
    const run: AutomationRun = {
      id: createId(),
      automationId: a.id,
      threadId,
      trigger,
      scheduledFor,
      startedAt,
      settledAt: closed === null ? null : startedAt,
      outcome: closed === null ? 'running' : closed.outcome,
      message: closed === null ? null : closed.message,
      summary: null,
      attention: false,
    }
    repo.insertRun(run)
    repo.trimRuns(a.id)
    return run
  }

  const skip = (
    a: Automation,
    trigger: RunTrigger,
    scheduledFor: number | null,
    message: string,
    threadId: string | null = null,
  ): AutomationRun => {
    const run = insertRun(a, trigger, scheduledFor, threadId, clock.now(), { outcome: 'skipped', message })
    d.emitRunUpdated(run)
    return run
  }

  /**
   * 这一次在哪条对话里跑（审查 R-14）。
   *
   * 续用模式：记着的对话还在、还在这个工作区 → 用它；它正在跑（用户正在里面聊，或别的什么）→
   * 这一次跳过 —— 排在用户那一轮后面的话，用户那一轮的 turnSettled 会被当成本次运行的结局。
   * 记着的对话没了 → 新建一条并重新记下（记忆从这里重新开始）。
   */
  const pickThread = (
    a: Automation,
    startedAt: number,
  ): { readonly kind: 'ready'; readonly threadId: string } | { readonly kind: 'busy'; readonly threadId: string } => {
    if (a.threadMode === 'continue' && a.threadId !== null) {
      const existing = conversation.get(a.threadId)
      if (existing !== null && existing.workspaceId === a.workspaceId) {
        return existing.state === 'idle'
          ? { kind: 'ready', threadId: existing.id }
          : { kind: 'busy', threadId: existing.id }
      }
    }
    const thread = conversation.createThread({
      workspaceId: a.workspaceId,
      title: a.threadMode === 'continue' ? `定时任务：${a.title}` : threadTitleOf(a, startedAt),
      origin: 'automation',
      posture: a.posture,
      model: a.model,
      thinking: a.thinking,
    })
    if (a.threadMode === 'continue') {
      repo.setThread(a.id, thread.id, startedAt)
      d.emitChanged()
    }
    return { kind: 'ready', threadId: thread.id }
  }

  /** 工作区不可用的说明；可用是 null */
  const workspaceProblemOf = (a: Automation): string | null => {
    try {
      workspaces.requireUsable(a.workspaceId)
      return null
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.warn('automation workspace unavailable', { automationId: a.id, error: message })
      return message
    }
  }

  return {
    async start(a, trigger, scheduledFor) {
      if (repo.openRun(a.id) !== null) {
        throw new AppError(automationsErrors.already_running, '这个任务正在运行')
      }
      const startedAt = clock.now()
      const unusable = workspaceProblemOf(a)
      if (unusable !== null) return settle(insertRun(a, trigger, scheduledFor, null, startedAt), 'failed', unusable)
      const picked = pickThread(a, startedAt)
      if (picked.kind === 'busy') return skip(a, trigger, scheduledFor, BUSY_THREAD_MESSAGE, picked.threadId)

      const run = insertRun(a, trigger, scheduledFor, picked.threadId, startedAt)
      try {
        await conversation.submit({ threadId: picked.threadId, text: framePrompt(a, trigger, scheduledFor) })
      } catch (e) {
        return settle(run, 'failed', e instanceof Error ? e.message : String(e))
      }
      /*
       * 交接失败的事件可能先于 `submit()` 的 await 返回（R-06 §3.3）：这时运行已经被
       * onSubmissionFailed 收成了 failed，这里再 publish 一次会把结局覆盖回 running。
       * 所以重新读库，只有还开着的运行才接着等轮终（库里的行没了就退回手里这一份）。
       */
      const current = openRunById(run.id)
      if (current === null) return repo.getRun(run.id) ?? run
      publish(current)
      watch(run.id, picked.threadId, startedAt)
      return current
    },
    skip: (a, trigger, scheduledFor, message) => skip(a, trigger, scheduledFor, message),
    report(threadId, summary, attention) {
      const open = repo.openRunsByThread(threadId)
      if (open.length === 0) {
        throw new AppError(
          automationsErrors.not_in_run,
          '这条对话当前没有在运行的定时任务：automation_report 只在定时任务运行中使用',
        )
      }
      return open.map((run) => {
        const reported: AutomationRun = { ...run, summary, attention }
        publish(reported)
        return reported
      })
    },
    onSubmissionFailed(e) {
      /* 用户在运行中插的话失败不该让这次运行失败 —— 只有 turn 方式才代表「这句话没开始」 */
      if (e.deliverAs !== 'turn') return
      for (const run of repo.openRunsByThread(e.threadId)) {
        settle(run, 'failed', `没能开始运行：${e.error.message}`)
      }
    },
    onThreadRemoved(e) {
      /* 对话被删不是任务出问题：收成 cancelled（noticeOf 对 cancelled 不通知） */
      for (const run of repo.openRunsByThread(e.threadId)) {
        settle(run, 'cancelled', '运行所在的对话已被删除')
      }
    },
    onTurnSettled(e) {
      for (const run of repo.openRunsByThread(e.threadId)) {
        settle(run, OUTCOME_OF[e.outcome], e.outcome === 'failed' ? (e.error?.message ?? '运行失败') : null)
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
      for (const w of watches.values()) w.timer.dispose()
      watches.clear()
    },
  }
}
