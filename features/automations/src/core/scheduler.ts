import type { Clock, Disposable, Logger } from '@poietica/foundation'
import type { Automation, RunTrigger } from '../contract/entities'
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

export function createScheduler(d: {
  readonly repo: AutomationsRepository
  readonly runner: Runner
  readonly clock: Clock
  readonly logger: Logger
}): Scheduler {
  const { clock, logger, repo, runner } = d
  const catchUps = new Set<string>()

  const advance = (a: Automation): void => {
    const { next, issue } = scheduleOf(a, clock.now())
    repo.setNextRun(a.id, next, clock.now())
    repo.setIssue(a.id, issue, clock.now())
  }

  const finish = (a: Automation): void => {
    if (isOnce(a)) {
      repo.setEnabled(a.id, false, clock.now())
      repo.setNextRun(a.id, null, clock.now())
      return
    }
    advance(a)
  }

  const launch = async (a: Automation): Promise<void> => {
    const late = a.nextRunAt !== null && clock.now() - a.nextRunAt > LATE_GRACE_MS
    const trigger: RunTrigger = catchUps.delete(a.id) || late ? 'catch_up' : 'schedule'
    if (a.schedule.cron === null && a.schedule.at === null) return
    if (late && !a.catchUp) {
      runner.skip(a, 'schedule', a.nextRunAt, LATE_MESSAGE)
      finish(a)
      return
    }
    if (runner.isRunning(a.id)) {
      runner.skip(a, trigger, a.nextRunAt, OVERLAP_MESSAGE)
      finish(a)
      return
    }
    /* 逐个启动是表格一致性前提（见 tick 注释），不是可并行的独立工作。 */
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await runner.start(a, trigger, a.nextRunAt)
    finish(a)
  }

  return {
    repairOnStartup() {
      const now = clock.now()
      repo.failOpenRuns('应用退出时仍在运行', now)
      for (const a of repo.listEnabled()) {
        const missed = a.issue === null && a.nextRunAt !== null && a.nextRunAt <= now
        if (missed && a.catchUp) {
          /* 不动 next_run_at：第一次 tick 就会把它挑出来，只补一次。 */
          catchUps.add(a.id)
          continue
        }
        if (missed) {
          runner.skip(a, 'schedule', a.nextRunAt, MISSED_MESSAGE)
          finish(a)
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
      for (const a of repo.due(clock.now())) {
        try {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          await launch(a)
        } catch (e) {
          logger.error('automation tick failed', { automationId: a.id, error: String(e) })
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
