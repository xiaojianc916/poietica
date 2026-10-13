import type { Clock, Disposable, Logger } from '@poietica/foundation'
import type { Automation, RunTrigger } from '../contract/entities'
import type { AutomationsRepository } from './repository'
import type { Runner } from './runner'
import { nextOf, PROBLEM_TEXT } from './schedule'

export const TICK_MS = 30_000

export const OVERLAP_MESSAGE = '上一次运行还没结束，跳过这一次'
export const MISSED_MESSAGE = '错过：计划时间应用没有运行'

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
      for (const a of repo.due(clock.now())) {
        const trigger: RunTrigger = catchUps.delete(a.id) ? 'catch_up' : 'schedule'
        try {
          if (a.schedule.cron === null && a.schedule.at === null) continue
          if (runner.isRunning(a.id)) {
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
