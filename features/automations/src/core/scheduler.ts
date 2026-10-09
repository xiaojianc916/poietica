import type { Clock, Disposable, Logger } from '@poietica/foundation'
import type { Automation } from '../contract/entities'
import type { AutomationsRepository } from './repository'
import type { Runner } from './runner'
import { nextAfter, PROBLEM_TEXT } from './schedule'

/** 调度器 tick 间隔（07 页 §9C「每 30 秒 tick」） */
export const TICK_MS = 30_000

export interface Scheduler {
  /** running/awaiting → failed；重算每个启用任务的 next_run_at 与 issue */
  repairOnStartup(): void
  tick(): Promise<void>
  start(): Disposable
}

/** 依据一项任务的计划算它的下一次运行与问题说明；cron 为 null 时两者都是空 */
export function scheduleOf(
  automation: Pick<Automation, 'schedule'>,
  now: number,
): { readonly next: number | null; readonly issue: string | null } {
  if (automation.schedule.cron === null) return { next: null, issue: null }
  const result = nextAfter(automation.schedule.cron, automation.schedule.timeZone, now)
  return { next: result.next, issue: result.problem === null ? null : PROBLEM_TEXT[result.problem] }
}

export function createScheduler(d: {
  readonly repo: AutomationsRepository
  readonly runner: Runner
  readonly clock: Clock
  readonly logger: Logger
}): Scheduler {
  const { clock, logger, repo, runner } = d

  const advance = (a: Automation): void => {
    const { next, issue } = scheduleOf(a, clock.now())
    repo.setNextRun(a.id, next, clock.now())
    repo.setIssue(a.id, issue, clock.now())
  }

  return {
    repairOnStartup() {
      const now = clock.now()
      repo.failOpenRuns('应用退出时仍在运行', now)
      for (const a of repo.listEnabled()) advance(a)
    },
    async tick() {
      for (const a of repo.due(clock.now())) {
        try {
          if (runner.isRunning(a.id)) {
            /* 同一任务不能并发：只把 next_run_at 推到下一次，不启动新运行 */
            advance(a)
            continue
          }
          if (a.schedule.cron === null) continue
          await runner.start(a, 'schedule', a.nextRunAt)
          advance(a)
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
