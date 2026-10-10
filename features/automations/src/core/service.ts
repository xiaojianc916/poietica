import type { ConversationService } from '@poietica/feature-conversation/core-api'
import { AppError, type Clock, createId, type Logger } from '@poietica/foundation'
import type { Automation, AutomationDraft, AutomationRun, Schedule } from '../contract/entities'
import { automationsErrors } from '../contract/errors'
import type { AutomationsRepository } from './repository'
import type { Runner } from './runner'
import { nextOf, PROBLEM_TEXT, previewOf, type ScheduleProblem } from './schedule'

/**
 * 更新用的一格 patch。
 *
 * 与 `Partial<AutomationDraft>` 的差别只在 exactOptionalPropertyTypes：线上传来的
 * 是 zod 的 `.partial()` 输出，缺席的键在类型上是 `T | undefined`。这里明确收下
 * undefined 并当作「不改这一格」。线上的 patch 表是契约的 AutomationPatch（不带默认值，审查 R-14）。
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
  /** 这条对话上有没有开着的定时任务运行（agent 工具据此拦下运行中的管理操作，审查 R-15） */
  inRun(threadId: string): boolean
  /** 运行中的 agent 交结论（automation_report） */
  report(threadId: string, summary: string, attention: boolean): AutomationRun[]
}

/**
 * 计划校验。`allowPast`：一次性时间已过算不算错 —— 新建、改计划、重新启用时算；
 * 只改别的字段（例如给跑完的一次性任务改个标题）时不算，那只是「做完了」。
 */
function assertSchedule(schedule: Schedule, now: number, allowPast: boolean): void {
  const { problem } = nextOf(schedule, now)
  if (problem === null || problem === 'never_runs') return
  if (problem === 'in_past' && allowPast) return
  throw new AppError(automationsErrors.invalid_schedule, PROBLEM_TEXT[problem])
}

/** patch 并进当前任务：缺席的键不改（model / thinking 可以显式改成 null） */
function mergePatch(current: Automation, patch: AutomationPatch): AutomationDraft {
  const workspaceId = patch.workspaceId ?? current.workspaceId
  /* 换了工作区而没指定续用哪条：原来那条在旧工作区里，不能再续用 —— 下次运行新建 */
  const threadId =
    patch.threadId !== undefined ? patch.threadId : workspaceId !== current.workspaceId ? null : current.threadId
  return {
    title: patch.title ?? current.title,
    prompt: patch.prompt ?? current.prompt,
    schedule: patch.schedule ?? current.schedule,
    workspaceId,
    posture: patch.posture ?? current.posture,
    model: patch.model === undefined ? current.model : patch.model,
    thinking: patch.thinking === undefined ? current.thinking : patch.thinking,
    threadMode: patch.threadMode ?? current.threadMode,
    threadId,
    notify: patch.notify ?? current.notify,
    catchUp: patch.catchUp ?? current.catchUp,
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

  /**
   * 下一次运行与 issue。一次性任务的时间已过不是 issue：它要么已经跑过（调度器跑完会停用它），
   * 要么是用户停用后时间过了 —— 两种都只是「没有下一次」。
   */
  const recompute = (id: string): Automation => {
    const automation = require_(id)
    const now = clock.now()
    const result = nextOf(automation.schedule, now)
    const issue = result.problem === null || result.problem === 'in_past' ? null : PROBLEM_TEXT[result.problem]
    repo.setNextRun(id, result.next, now)
    repo.setIssue(id, issue, now)
    return require_(id)
  }

  /**
   * 续用对话的规矩（审查 R-14）：每次新开 → 不记对话；续用 → 记着的那条必须还在、且在任务的工作区里。
   * 记着的是 null 表示「下一次运行新建一条再记下」。
   */
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
      assertSchedule(draft.schedule, now, false)
      const created = repo.create(createId(), normalizeThread(draft), now)
      return recompute(created.id)
    },
    update(id, patch) {
      const next = mergePatch(require_(id), patch)
      const now = clock.now()
      assertSchedule(next.schedule, now, patch.schedule === undefined)
      const updated = repo.update(id, normalizeThread(next), now)
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
      const automation = require_(id)
      if (enabled) assertSchedule(automation.schedule, clock.now(), false)
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
      return previewOf(schedule, clock.now(), count)
    },
    recompute,
    inRun: (threadId) => repo.openRunsByThread(threadId).length > 0,
    report: (threadId, summary, attention) => runner.report(threadId, summary, attention),
  }
}
