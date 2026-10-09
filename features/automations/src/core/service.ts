import { AppError, type Clock, createId, type Logger } from '@poietica/foundation'
import type { Automation, AutomationDraft, AutomationRun, Schedule } from '../contract/entities'
import { automationsErrors } from '../contract/errors'
import type { AutomationsRepository } from './repository'
import type { Runner } from './runner'
import { nextAfter, PROBLEM_TEXT, preview, type ScheduleProblem } from './schedule'

/**
 * 更新用的一格 patch。
 *
 * 与 `Partial<AutomationDraft>` 的差别只在 exactOptionalPropertyTypes：线上传来的
 * 是 zod 的 `.partial()` 输出，缺席的键在类型上是 `T | undefined`。这里明确收下
 * undefined 并当作「不改这一格」——与 07 页 §9D 的 `automation_update` 语义一致。
 */
export type AutomationPatch = { readonly [K in keyof AutomationDraft]?: AutomationDraft[K] | undefined }

export interface AutomationsService {
  list(): Automation[]
  get(id: string): Automation
  create(draft: AutomationDraft): Automation
  update(id: string, patch: AutomationPatch): Automation
  remove(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean): Automation
  runNow(id: string): Promise<AutomationRun>
  cancel(runId: string): Promise<void>
  runs(id: string, limit: number): AutomationRun[]
  previewSchedule(schedule: Schedule, count: number): { times: number[]; problem: ScheduleProblem | null }
  recompute(id: string): Automation
}

function assertSchedule(schedule: Schedule, now: number): void {
  const result = nextAfter(schedule.cron, schedule.timeZone, now)
  if (result.problem === 'time_zone' || result.problem === 'unreadable' || result.problem === 'too_frequent') {
    throw new AppError(automationsErrors.invalid_schedule, PROBLEM_TEXT[result.problem])
  }
}

export function createAutomationsService(d: {
  readonly repo: AutomationsRepository
  readonly runner: Runner
  readonly clock: Clock
  readonly logger: Logger
}): AutomationsService {
  const { clock, repo, runner } = d

  const recompute = (id: string): Automation => {
    const automation = require_(id)
    const result = nextAfter(automation.schedule.cron, automation.schedule.timeZone, clock.now())
    repo.setNextRun(id, result.next, clock.now())
    repo.setIssue(id, result.problem === null ? null : PROBLEM_TEXT[result.problem], clock.now())
    return require_(id)
  }

  function require_(id: string): Automation {
    const automation = repo.get(id)
    if (automation === null) {
      throw new AppError(automationsErrors.not_found, '定时任务不存在')
    }
    return automation
  }

  return {
    list: () => repo.list(),
    get: require_,
    create(draft) {
      const now = clock.now()
      assertSchedule(draft.schedule, now)
      const id = createId()
      const created = repo.create(id, draft, now)
      return recompute(created.id)
    },
    update(id, patch) {
      const current = require_(id)
      const next: AutomationDraft = {
        title: patch.title ?? current.title,
        prompt: patch.prompt ?? current.prompt,
        schedule: patch.schedule ?? current.schedule,
        workspaceId: patch.workspaceId ?? current.workspaceId,
        posture: patch.posture ?? current.posture,
        model: patch.model === undefined ? current.model : patch.model,
        thinking: patch.thinking === undefined ? current.thinking : patch.thinking,
      }
      const now = clock.now()
      assertSchedule(next.schedule, now)
      const updated = repo.update(id, next, now)
      if (updated === null) {
        throw new AppError(automationsErrors.not_found, '定时任务不存在')
      }
      return recompute(id)
    },
    async remove(id) {
      const automation = require_(id)
      const open = repo.openRun(automation.id)
      if (open !== null) {
        await runner.cancel(open.id)
      }
      repo.remove(id)
    },
    setEnabled(id, enabled) {
      require_(id)
      repo.setEnabled(id, enabled, clock.now())
      return recompute(id)
    },
    async runNow(id) {
      const automation = require_(id)
      if (runner.isRunning(automation.id)) {
        throw new AppError(automationsErrors.already_running, '这个任务正在运行')
      }
      return runner.start(automation, 'manual', null)
    },
    cancel(runId) {
      return runner.cancel(runId)
    },
    runs(id, limit) {
      require_(id)
      return repo.runs(id, limit)
    },
    previewSchedule(schedule, count) {
      const result = preview(schedule.cron, schedule.timeZone, clock.now(), count)
      return { times: result.times, problem: result.problem }
    },
    recompute,
  }
}
