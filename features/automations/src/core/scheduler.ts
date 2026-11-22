import type { Clock, Disposable, Logger } from '@poietica/foundation'
import type { Automation, AutomationRun, RunTrigger } from '../contract/entities'
import type { AutomationsRepository } from './repository'
import type { Runner } from './runner'
import { nextOf, PROBLEM_TEXT } from './schedule'

export const TICK_MS = 30_000

export const OVERLAP_MESSAGE = '上一次运行还没结束，跳过这一次'
export const MISSED_MESSAGE = '错过：计划时间应用没有运行'
export const LATE_MESSAGE = '错过：计划时间电脑在睡眠或应用被挂起'

/**
 * 到期多久之内仍算「准点」。正常情况下迟到不超过一个 TICK_MS（加上事件循环的抖动）；
 * 迟到得远超于此，说明计划时间那一刻进程虽然活着却没在跑 —— 睡眠 / 休眠、调试器暂停、事件循环被长时间占住。
 * 这和「应用没开着」是同一件事，必须同样按 catchUp 处理，而不是当成准点照跑。
 */
export const LATE_GRACE_MS = 5 * 60_000

export interface Scheduler {
  repairOnStartup(): void
  tick(): Promise<void>
  start(): Disposable
}

export function scheduleOf(
  automation: Pick<Automation, 'schedule'>,
  now: number,
): { readonly next: number | null; readonly issue: string | null } {
  const result = nextOf(automation.schedule, now)
  if (result.problem === null || result.problem === 'in_past') return { next: result.next, issue: null }
  return { next: null, issue: PROBLEM_TEXT[result.problem] }
}

const isOnce = (a: Pick<Automation, 'schedule'>): boolean => a.schedule.at !== null && a.schedule.cron === null

/** 一个到期窗口的幂等键：同一任务、同一计划时刻只允许一条运行台账。 */
export function scheduledRunId(automationId: string, scheduledFor: number): string {
  return `${automationId}:${scheduledFor}`
}

export function createScheduler(d: {
  readonly repo: AutomationsRepository
  readonly runner: Runner
  readonly clock: Clock
  readonly logger: Logger
}): Scheduler {
  const { clock, logger, repo, runner } = d
  /** 启动修复时发现「错过了但该补跑」的任务；第一次 tick 挑它们时记成 catch_up。 */
  const catchUps = new Set<string>()

  interface Plan {
    readonly next: number | null
    readonly issue: string | null
    readonly finalize: boolean
  }

  /** 次数上限与截止时刻在这里收口：达到后不再排下一次，下一次 tick 也不会再认领。 */
  const planOf = (a: Automation, now: number, runCount = a.runCount): Plan => {
    const { next, issue } = scheduleOf(a, now)
    const ended = a.endAt !== null && (next === null || next > a.endAt)
    const exhausted = a.maxRuns !== null && runCount >= a.maxRuns
    if (ended || exhausted) return { next: null, issue, finalize: true }
    return { next, issue, finalize: isOnce(a) && next === null }
  }

  const advance = (a: Automation): void => {
    const now = clock.now()
    const plan = planOf(a, now)
    repo.setNextRun(a.id, plan.next, now)
    repo.setIssue(a.id, plan.issue, now)
    if (plan.finalize) repo.setEnabled(a.id, false, now)
  }

  /** 跳过这一窗口并推进计划；一次性任务或已达限额就是终态。 */
  const skipAndAdvance = (a: Automation, trigger: RunTrigger, scheduledFor: number | null, message: string): void => {
    const now = clock.now()
    const plan = planOf(a, now)
    runner.skip(a, trigger, scheduledFor, message)
    repo.setIssue(a.id, plan.issue, now)
    repo.markSkipped(a.id, { at: now, nextRunAt: plan.next, finalize: plan.finalize })
  }

  const dispatched = (a: Automation): void => {
    const now = clock.now()
    const plan = planOf(a, now, a.runCount + 1)
    repo.markDispatched(a.id, { dispatchedAt: now, nextRunAt: plan.next })
    repo.setIssue(a.id, plan.issue, now)
    if (plan.finalize) repo.setEnabled(a.id, false, now)
  }

  const failedToDispatch = (a: Automation, message: string): void => {
    const { next } = scheduleOf(a, clock.now())
    repo.markDispatchFailed(a.id, {
      failedAt: clock.now(),
      error: message,
      kind: 'transient',
      nextRunAt: next,
    })
  }

  /** 台账里已经有这个窗口的运行：崩溃发生在「写运行」与「推进 next_run_at」之间。不重开，只把计划补齐。 */
  const hasSettledLedger = (a: Automation, scheduledFor: number, now: number): boolean => {
    const existing = repo.getRun(scheduledRunId(a.id, scheduledFor))
    if (existing === null || existing.dispatchStatus === 'failed_to_dispatch') return false
    const { next, issue } = scheduleOf(a, now)
    repo.setIssue(a.id, issue, now)
    repo.markSkipped(a.id, { at: now, nextRunAt: isOnce(a) ? null : next, finalize: isOnce(a) })
    return true
  }

  /** 关机/休眠期间错过的窗口：一次性任务直接终态；循环任务按 catchUp 决定补跑还是跳过。 */
  const handleMissed = (a: Automation, scheduledFor: number, retrying: boolean, now: number): boolean => {
    const missed = !retrying && a.nextRunAt !== null && a.nextRunAt <= now - LATE_GRACE_MS
    if (missed && isOnce(a)) {
      skipAndAdvance(a, 'schedule', scheduledFor, MISSED_MESSAGE)
      return true
    }
    if (missed && !a.catchUp) {
      skipAndAdvance(a, 'schedule', scheduledFor, LATE_MESSAGE)
      return true
    }
    if (missed) catchUps.add(a.id)
    return false
  }

  const triggerOf = (a: Automation, retrying: boolean, missed: boolean): RunTrigger =>
    retrying ? 'schedule' : catchUps.delete(a.id) || missed ? 'catch_up' : 'schedule'

  const settleLaunch = (a: Automation, run: AutomationRun, trigger: RunTrigger, scheduledFor: number): void => {
    if (run.outcome === 'failed' && run.dispatchStatus === 'failed_to_dispatch') {
      failedToDispatch(a, run.message ?? '派发失败')
      return
    }
    if (run.outcome === 'skipped') {
      skipAndAdvance(a, trigger, scheduledFor, run.message ?? OVERLAP_MESSAGE)
      return
    }
    dispatched(a)
  }

  const launch = async (a: Automation): Promise<void> => {
    const now = clock.now()
    const retrying = a.retryAt !== null
    const scheduledFor = a.nextRunAt ?? a.retryAt
    if (scheduledFor === null) {
      repo.markSkipped(a.id, { at: now, nextRunAt: null, finalize: isOnce(a) })
      return
    }
    if (hasSettledLedger(a, scheduledFor, now)) return
    const missed = !retrying && a.nextRunAt !== null && a.nextRunAt <= now - LATE_GRACE_MS
    if (handleMissed(a, scheduledFor, retrying, now)) return
    if (runner.isRunning(a.id)) {
      skipAndAdvance(a, 'schedule', scheduledFor, OVERLAP_MESSAGE)
      return
    }

    const trigger = triggerOf(a, retrying, missed)
    const existing = repo.getRun(scheduledRunId(a.id, scheduledFor))
    /* 逐个启动是表格一致性前提（见 tick 注释），不是可并行的独立工作。 */
    const run = await runner.start(a, trigger, scheduledFor, {
      runId: scheduledRunId(a.id, scheduledFor),
      retryThreadId: existing?.threadId ?? null,
    })
    settleLaunch(a, run, trigger, scheduledFor)
  }

  return {
    repairOnStartup() {
      const now = clock.now()
      /* Core 刚起来：上一个进程留下的认领都不可信（进程已退出），先释放再修账。 */
      repo.clearClaims(now)
      repo.failOpenRuns('应用退出时仍在运行', now)
      for (const a of repo.listEnabled()) {
        const missed = a.issue === null && a.nextRunAt !== null && a.nextRunAt <= now
        /* 一次性任务没有补跑语义：错过即终态，交给 skipAndAdvance 统一收。 */
        if (missed && a.catchUp && !isOnce(a)) {
          /* 不动 next_run_at：第一次 tick 就会把它挑出来，只补一次。 */
          catchUps.add(a.id)
          continue
        }
        if (missed) {
          skipAndAdvance(a, 'schedule', a.nextRunAt, MISSED_MESSAGE)
          continue
        }
        advance(a)
      }
    },
    async tick() {
      /*
       * 到期任务逐个启动：runner.start 会写运行行、推进 next_run_at、必要时跳过同任务重叠的那一次，
       * 这些读写都落在同一张表上且与任务顺序有关。并发启动既省不了几次本地写入，又会让
       * 「上一次运行还没结束」的判定与 next_run_at 推进互相穿插。
       */
      for (const a of repo.claimDue(clock.now())) {
        try {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          await launch(a)
        } catch (e) {
          logger.error('automation tick failed', { automationId: a.id, error: String(e) })
          try {
            failedToDispatch(a, e instanceof Error ? e.message : String(e))
          } catch (settleError) {
            logger.error('automation dispatch failure settlement failed', {
              automationId: a.id,
              error: String(settleError),
            })
            repo.releaseClaim(a.id, clock.now())
          }
        }
      }
    },
    start() {
      return clock.setInterval(() => {
        void this.tick().catch((e: unknown) => {
          logger.error('automation tick failed', { error: String(e) })
        })
      }, TICK_MS)
    },
  }
}
