import type { Clock, Disposable, Logger } from '@poietica/foundation'
import type { Automation, RunTrigger } from '../contract/entities'
import type { AutomationsRepository } from './repository'
import type { Runner } from './runner'
import { nextOf, PROBLEM_TEXT } from './schedule'

/** 调度器 tick 间隔（07 页 §9C「每 30 秒 tick」） */
export const TICK_MS = 30_000

export const OVERLAP_MESSAGE = '上一次运行还没结束，跳过这一次'
export const MISSED_MESSAGE = '错过：计划时间应用没有运行'

export interface Scheduler {
  /** running/awaiting → failed；错过的计划按任务的 catchUp 补跑或记一条跳过；重算 next_run_at 与 issue */
  repairOnStartup(): void
  tick(): Promise<void>
  start(): Disposable
}

/** 依据一项任务的计划算它的下一次运行与问题说明；只手动运行与「一次性且时间已过」两者都是空 */
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
  /** 启动时发现错过、且要补跑的任务：下一次 tick 以 catch_up 触发 */
  const catchUps = new Set<string>()

  const advance = (a: Automation): void => {
    const { next, issue } = scheduleOf(a, clock.now())
    repo.setNextRun(a.id, next, clock.now())
    repo.setIssue(a.id, issue, clock.now())
  }

  /** 这一次（跑了或跳过了）之后：一次性任务停用，周期任务推到下一次 */
  const finish = (a: Automation): void => {
    if (isOnce(a)) {
      repo.setEnabled(a.id, false, clock.now())
      repo.setNextRun(a.id, null, clock.now())
      return
    }
    advance(a)
  }

  return {
    repairOnStartup() {
      const now = clock.now()
      repo.failOpenRuns('应用退出时仍在运行', now)
      for (const a of repo.listEnabled()) {
        const missed = a.issue === null && a.nextRunAt !== null && a.nextRunAt <= now
        if (missed && a.catchUp) {
          /* 不动 next_run_at：它仍是过去的时刻，第一次 tick 就会把它挑出来 —— 只补一次 */
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
      for (const a of repo.due(clock.now())) {
        const trigger: RunTrigger = catchUps.delete(a.id) ? 'catch_up' : 'schedule'
        try {
          if (a.schedule.cron === null && a.schedule.at === null) continue
          if (runner.isRunning(a.id)) {
            /* 同一任务不能并发：记一条跳过，再推到下一次 */
            runner.skip(a, trigger, a.nextRunAt, OVERLAP_MESSAGE)
            finish(a)
            continue
          }
          await runner.start(a, trigger, a.nextRunAt)
          finish(a)
        } catch (e) {
          logger.error('automation tick failed', { automationId: a.id, error: String(e) })
        }
      }
    },
    start() {
      return clock.setInterval(() => {
        void this.tick()
      }, TICK_MS)
    },
  }
}
