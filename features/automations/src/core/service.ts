import type { ConversationService } from '@poietica/feature-conversation/core-api'
import { AppError, type Clock, createId, type Logger } from '@poietica/foundation'
import type { Automation, AutomationDraft, AutomationRun, Schedule } from '../contract/entities'
import { automationsErrors } from '../contract/errors'
import type { AutomationsRepository } from './repository'
import { AUTOMATION_CREATE_LIMIT } from './repository'
import type { Runner } from './runner'
import { nextOf, PROBLEM_TEXT, previewOf, type ScheduleProblem } from './schedule'
import { compatCronOf } from './schedule-rule'

/** 更新用的一格 patch。差别只在 exactOptionalPropertyTypes：线上传来的是 zod 的 .partial() 输出，缺席的键在类型上是
 * T | undefined，这里明确收下并当作「不改这一格」。 */
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
  /** agent 工具据此拦下运行中的管理操作。 */
  inRun(threadId: string): boolean
  /** 运行中的任务可以停掉自己的后续排程；当前这一轮继续跑。 */
  pauseSelf(threadId: string): Automation
  report(threadId: string, summary: string, attention: boolean): AutomationRun[]
}

function assertSchedule(schedule: Schedule, now: number, allowPast: boolean): void {
  const { problem } = nextOf(schedule, now)
  if (problem === null || problem === 'never_runs') return
  if (problem === 'in_past' && allowPast) return
  throw new AppError(automationsErrors.invalid_schedule, PROBLEM_TEXT[problem])
}

function assertLimits(draft: AutomationDraft, now: number): void {
  if (draft.endAt !== undefined && draft.endAt !== null && draft.endAt <= now) {
    throw new AppError(automationsErrors.invalid_schedule, '截止时间必须晚于现在')
  }
}

/** 编辑器存盘不带 rule：计划三格没变就保留原规则，改了则明确改回 cron/at。 */
function mergedSchedule(current: Schedule, next: Schedule | undefined): Schedule {
  if (next === undefined) return current
  if (next.rule !== undefined) return next
  const unchanged = next.cron === current.cron && next.at === current.at && next.timeZone === current.timeZone
  return { ...next, rule: unchanged ? (current.rule ?? null) : null }
}

/** 规则存在时由服务端写兼容 cron：UI 不必复制一份展示表达式，改规则也不会留下旧 cron。 */
function normalizedSchedule(schedule: Schedule): Schedule {
  if (schedule.rule == null) return schedule
  return { ...schedule, cron: compatCronOf(schedule.rule), at: null }
}

function mergePatch(current: Automation, patch: AutomationPatch): AutomationDraft {
  const workspaceId = patch.workspaceId ?? current.workspaceId
  const threadId =
    patch.threadId !== undefined ? patch.threadId : workspaceId !== current.workspaceId ? null : current.threadId
  return {
    title: patch.title ?? current.title,
    prompt: patch.prompt ?? current.prompt,
    schedule: normalizedSchedule(mergedSchedule(current.schedule, patch.schedule)),
    workspaceId,
    posture: patch.posture ?? current.posture,
    model: patch.model === undefined ? current.model : patch.model,
    thinking: patch.thinking === undefined ? current.thinking : patch.thinking,
    threadMode: patch.threadMode ?? current.threadMode,
    threadId,
    notify: patch.notify ?? current.notify,
    catchUp: patch.catchUp ?? current.catchUp,
    maxRuns: patch.maxRuns !== undefined ? patch.maxRuns : current.maxRuns,
    endAt: patch.endAt !== undefined ? patch.endAt : current.endAt,
  }
}

export function createAutomationsService(d: {
  readonly repo: AutomationsRepository
  readonly runner: Runner
  readonly conversation: Pick<ConversationService, 'get'>
  readonly clock: Clock
  readonly logger: Logger
}): AutomationsService {
  const { clock, conversation, repo, runner } = d

  function require_(id: string): Automation {
    const automation = repo.get(id)
    if (automation === null) {
      throw new AppError(automationsErrors.not_found, '定时任务不存在')
    }
    return automation
  }

  /** 一次性任务的时间已过不是 issue：要么已经跑过，要么是用户停用后才过期 —— 都只是「没有下一次」。 */
  const recompute = (id: string): Automation => {
    const automation = require_(id)
    const now = clock.now()
    const result = nextOf(automation.schedule, now)
    const issue = result.problem === null || result.problem === 'in_past' ? null : PROBLEM_TEXT[result.problem]
    repo.setNextRun(id, result.next, now)
    repo.setIssue(id, issue, now)
    return require_(id)
  }

  /** 续用 → 记着的那条必须还在、且在任务的工作区里；null 表示下次运行新建一条再记下。 */
  const normalizeThread = (draft: AutomationDraft): AutomationDraft => {
    if (draft.threadMode === 'new') return draft.threadId === null ? draft : { ...draft, threadId: null }
    if (draft.threadId === null) return draft
    const thread = conversation.get(draft.threadId)
    if (thread === null) {
      throw new AppError(automationsErrors.invalid_thread, '续用的对话不存在（可能已被删除）')
    }
    if (thread.workspaceId !== draft.workspaceId) {
      throw new AppError(automationsErrors.invalid_thread, '续用的对话不在这个任务的工作区里')
    }
    return draft
  }

  return {
    list: () => repo.list(),
    get: require_,
    create(draft) {
      const now = clock.now()
      /* 全库上限，所有状态都占名额；Core 是唯一写者，同步 COUNT + INSERT 之间没有可穿插的 await。 */
      if (repo.count() >= AUTOMATION_CREATE_LIMIT) {
        throw new AppError(
          automationsErrors.create_limit,
          `最多保留 ${AUTOMATION_CREATE_LIMIT} 条定时任务，请先删除一条`,
        )
      }
      assertSchedule(draft.schedule, now, false)
      assertLimits(draft, now)
      const normalized = normalizeThread({ ...draft, schedule: normalizedSchedule(draft.schedule) })
      const created = repo.create(createId(), normalized, now)
      return recompute(created.id)
    },
    update(id, patch) {
      const next = mergePatch(require_(id), patch)
      const now = clock.now()
      assertSchedule(next.schedule, now, patch.schedule === undefined)
      /* 只在显式改截止时校验：已结束的任务仍要能改名/改提示词。 */
      if (patch.endAt !== undefined) assertLimits(next, now)
      const updated = repo.update(id, normalizeThread(next), now)
      if (updated === null) {
        throw new AppError(automationsErrors.not_found, '定时任务不存在')
      }
      /* 计划或限额改了，旧窗口的退避重试不再有意义。 */
      if (patch.schedule !== undefined || patch.maxRuns !== undefined || patch.endAt !== undefined) {
        repo.resetDispatch(id, now)
      }
      return recompute(id)
    },
    async remove(id) {
      const automation = require_(id)
      const open = repo.openRun(automation.id)
      if (open !== null) {
        await runner.cancel(open.id)
      }
      repo.releaseClaim(id, clock.now())
      repo.remove(id)
    },
    setEnabled(id, enabled) {
      const automation = require_(id)
      if (enabled) assertSchedule(automation.schedule, clock.now(), false)
      repo.setEnabled(id, enabled, clock.now())
      if (enabled) repo.resetDispatch(id, clock.now())
      else repo.releaseClaim(id, clock.now())
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
      return previewOf(schedule, clock.now(), count)
    },
    recompute,
    inRun: (threadId) => repo.openRunsByThread(threadId).length > 0,
    pauseSelf(threadId) {
      const open = repo.openRunsByThread(threadId)[0]
      if (open === undefined) {
        throw new AppError(
          automationsErrors.not_in_run,
          '这条对话当前没有在运行的定时任务：automation_pause_self 只在定时任务运行中使用',
        )
      }
      const now = clock.now()
      repo.setEnabled(open.automationId, false, now)
      repo.releaseClaim(open.automationId, now)
      return recompute(open.automationId)
    },
    report: (threadId, summary, attention) => runner.report(threadId, summary, attention),
  }
}
