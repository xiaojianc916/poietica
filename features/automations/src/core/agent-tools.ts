import type { AgentToolRegistry } from '@poietica/core-kernel'
import type { ConversationService } from '@poietica/feature-conversation/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, type Clock, SystemErrorCode } from '@poietica/foundation'
import type { Controls, ModelRef, Posture, RuntimeServices } from '@poietica/runtime-protocol'
import { z } from 'zod'
import type { Automation, AutomationDraft, AutomationRun, Schedule, ScheduleRule } from '../contract/entities'
import { automationsErrors } from '../contract/errors'
import { compatCronOf, defaultFields, parseCompatFields, ruleFromInterval } from './schedule-rule'
import type { AutomationPatch, AutomationsService } from './service'
import { isoIn, parseIsoWithOffset } from './time'

/* 定时任务的 agent 工具，八张：options / list / runs / create / update / run / delete / report。时间一律是带时差的
 * ISO 8601，时区默认本机时区；可选值由 automation_options 一次给全，传错报中文错误并列出可选值；结果是 JSON 文本，
 * 同一份既给模型读也给对话里的工具卡片画；任务**运行中**只许 options / list / runs / report，不许建改删与手动运行，
 * 防止任务自我繁殖或改写自己。 */

const POSTURE_TEXT: Readonly<Record<Posture, string>> = {
  ask: 'ask：每次改文件、跑命令都要用户批准（无人值守时会卡住等批准）',
  'auto-edit': 'auto-edit（默认）：工作区内改文件不问；跑命令等仍要批准',
  'full-access': 'full-access：不问任何批准，完全访问',
}

const scheduleParam = z
  .object({
    type: z
      .enum(['cron', 'once', 'manual'])
      .describe('"cron" = repeating, "once" = run one time at `at`, "manual" = only when run by hand'),
    cron: z
      .string()
      .min(1)
      .optional()
      .describe(
        'For type "cron": 5-field crontab "minute hour day-of-month month day-of-week", e.g. "0 9 * * 1-5" = 09:00 on weekdays. Minimum granularity is one minute.',
      ),
    at: z
      .string()
      .min(1)
      .optional()
      .describe('For type "once": ISO 8601 time WITH offset, e.g. "2026-05-02T09:00:00+08:00".'),
    intervalUnit: z
      .enum(['minute', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'])
      .optional()
      .describe(
        'Custom recurring interval. Pair with `interval` for "every N minutes/hours/days/weeks/months/years"; use it when cron cannot express the step (e.g. every 90 minutes). `cron`, if given, only supplies the time-of-day fields.',
      ),
    interval: z.number().int().min(1).max(200).optional().describe('1-200, must be paired with intervalUnit.'),
  })
  .describe('When the automation runs.')

const modelParam = z.object({ provider: z.string().min(1), id: z.string().min(1) })

const settingsShape = {
  timeZone: z
    .string()
    .min(1)
    .optional()
    .describe("IANA time zone the schedule is read in. Defaults to the user's time zone (see automation_options)."),
  workspaceId: z
    .string()
    .min(1)
    .optional()
    .describe('Workspace to run in (id from automation_options). Defaults to the workspace of this conversation.'),
  model: modelParam
    .nullable()
    .optional()
    .describe("Model to run with ({provider,id} from automation_options). null = the user's default model."),
  thinking: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Thinking level id for that model (from automation_options). null = default.'),
  posture: z
    .enum(['ask', 'auto-edit', 'full-access'])
    .optional()
    .describe(
      'Approval posture for the runs. Default "auto-edit". Runs are unattended: "ask" will stall on approvals.',
    ),
  thread: z
    .enum(['new', 'continue', 'this'])
    .optional()
    .describe(
      '"new" (default): a fresh conversation for every run. "continue": every run continues one dedicated conversation, so it remembers earlier runs. "this": every run continues THIS conversation — use it for "check back on this later" follow-ups.',
    ),
  notify: z
    .enum(['always', 'attention', 'never'])
    .optional()
    .describe(
      'System notification. "attention" (default): on failure, when waiting for approval, or when the run reports attention=true. "always": also on every success. "never": never.',
    ),
  catchUp: z
    .boolean()
    .optional()
    .describe('If the app was not running at a scheduled time, run once when it starts again (default true).'),
}

const limitShape = {
  recurring: z
    .boolean()
    .optional()
    .describe(
      'true (default) repeats until paused or deleted; false creates a finite automation. Without maxRuns a finite automation runs once.',
    ),
  maxRuns: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Maximum successful scheduled runs. Only valid with recurring=false.'),
  endAt: z
    .string()
    .min(1)
    .optional()
    .describe('ISO 8601 time WITH offset: no run is scheduled after it, e.g. "2026-06-30T23:59:59+08:00".'),
}

const createParams = z.object({
  title: z.string().trim().min(1).max(80).describe('Short title shown in the list, e.g. "每日 CI 巡检"'),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe('The full instruction the agent receives at each run. Self-contained: the run may not see this chat.'),
  schedule: scheduleParam,
  ...settingsShape,
  ...limitShape,
})

const updateParams = z.object({
  id: z.string().min(1).describe('Automation id'),
  title: createParams.shape.title.optional(),
  prompt: createParams.shape.prompt.optional(),
  schedule: scheduleParam.optional(),
  ...settingsShape,
  ...limitShape,
  enabled: z.boolean().optional().describe('false = pause, true = resume'),
})

const idParams = z.object({ id: z.string().min(1).describe('Automation id') })
const listParams = z.object({
  workspaceId: z.string().min(1).optional().describe('Only automations of this workspace'),
})
const runsParams = z.object({
  id: z.string().min(1).describe('Automation id'),
  limit: z.number().int().min(1).max(20).optional().describe('How many recent runs (default 5)'),
})
const optionsParams = z.object({
  model: modelParam.optional().describe('Also list the thinking levels of this model (default: the default model)'),
})
const reportParams = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('One or two sentences: the conclusion of this run. Shown in the automation list and in notifications.'),
  attention: z
    .boolean()
    .optional()
    .describe(
      'true when the user should look at this (something failed, changed, or needs a decision). Default false.',
    ),
})

type ScheduleParam = z.output<typeof scheduleParam>
type SettingsParams = { readonly [K in keyof typeof settingsShape]?: z.output<(typeof settingsShape)[K]> }

const json = (value: unknown): { text: string } => ({ text: JSON.stringify(value) })

function invalid(message: string): never {
  throw new AppError(SystemErrorCode.invalidParams, message)
}

function chinese(e: unknown): never {
  if (e instanceof AppError) throw e
  throw new AppError(SystemErrorCode.invalidParams, e instanceof Error ? e.message : String(e))
}

const refText = (ref: ModelRef): string => `${ref.provider}/${ref.id}`

export function registerAgentTools(d: {
  readonly tools: AgentToolRegistry
  readonly service: AutomationsService
  readonly conversation: ConversationService
  readonly workspaces: WorkspacesService
  readonly agentRuntime: Pick<RuntimeServices['sessions'], 'draftControls'>
  readonly clock: Clock
  readonly localTimeZone: () => string
}): void {
  const { conversation, agentRuntime, service, tools, workspaces } = d

  const iso = (at: number | null, timeZone: string): string | null => (at === null ? null : isoIn(at, timeZone))

  const scheduleView = (s: Schedule) =>
    s.rule != null
      ? {
          type: 'interval' as const,
          unit: s.rule.unit,
          interval: s.rule.interval,
          cron: s.cron,
          timeZone: s.timeZone,
        }
      : s.cron !== null
        ? { type: 'cron' as const, cron: s.cron, timeZone: s.timeZone }
        : s.at !== null
          ? { type: 'once' as const, at: isoIn(s.at, s.timeZone), timeZone: s.timeZone }
          : { type: 'manual' as const, timeZone: s.timeZone }

  const runView = (run: AutomationRun, timeZone: string) => ({
    id: run.id,
    outcome: run.outcome,
    trigger: run.trigger,
    startedAt: isoIn(run.startedAt, timeZone),
    settledAt: iso(run.settledAt, timeZone),
    summary: run.summary,
    attention: run.attention,
    message: run.message,
    threadId: run.threadId,
  })

  const modelLabels = async (): Promise<Map<string, string>> => {
    const controls = await agentRuntime.draftControls({})
    return new Map(controls.model.choices.map((c) => [refText(c.ref), c.label]))
  }

  const viewOf = (a: Automation, sessionKey: string, labels: ReadonlyMap<string, string>) => ({
    id: a.id,
    title: a.title,
    prompt: a.prompt,
    enabled: a.enabled,
    schedule: scheduleView(a.schedule),
    nextRunAt: iso(a.nextRunAt, a.schedule.timeZone),
    workspace: { id: a.workspaceId, name: workspaces.get(a.workspaceId)?.name ?? a.workspaceId },
    model: a.model === null ? null : { ...a.model, label: labels.get(refText(a.model)) ?? a.model.id },
    thinking: a.thinking,
    posture: a.posture,
    thread:
      a.threadMode === 'new' ? ('new' as const) : a.threadId === sessionKey ? ('this' as const) : ('continue' as const),
    threadId: a.threadId,
    notify: a.notify,
    catchUp: a.catchUp,
    runCount: a.runCount,
    maxRuns: a.maxRuns,
    endAt: iso(a.endAt, a.schedule.timeZone),
    dispatchStatus: a.dispatchStatus,
    dispatchAttempts: a.dispatchAttempts,
    retryAt: iso(a.retryAt, a.schedule.timeZone),
    lastError: a.lastError,
    issue: a.issue,
    lastRun: a.lastRun === null ? null : runView(a.lastRun, a.schedule.timeZone),
  })

  const detailOf = async (a: Automation, sessionKey: string) => ({
    ...viewOf(a, sessionKey, await modelLabels()),
    upcoming: service.previewSchedule(a.schedule, 3).times.map((t) => isoIn(t, a.schedule.timeZone)),
  })

  const ruleOf = (p: ScheduleParam, timeZone: string): ScheduleRule | null => {
    if (p.intervalUnit === undefined && p.interval === undefined) return null
    if (p.intervalUnit === undefined || p.interval === undefined) {
      invalid('intervalUnit 与 interval 必须成对给（每 N 分钟/小时/天/周/月/年）')
    }
    const anchorAt = d.clock.now()
    const fields =
      p.cron === undefined ? defaultFields(anchorAt, timeZone) : parseCompatFields(p.cron, anchorAt, timeZone)
    return ruleFromInterval(p.intervalUnit, p.interval, fields, anchorAt)
  }

  const manualSchedule = (rule: ScheduleRule | null, timeZone: string): Schedule => {
    if (rule !== null) invalid('type 为 manual 时不能给 intervalUnit/interval')
    return { cron: null, at: null, timeZone, rule: null }
  }

  const onceSchedule = (p: ScheduleParam, rule: ScheduleRule | null, timeZone: string): Schedule => {
    if (rule !== null) invalid('type 为 once 时不能给 intervalUnit/interval')
    if (p.at === undefined) invalid('schedule.type 为 once 时必须给 schedule.at（带时差的 ISO 8601）')
    const at = parseIsoWithOffset(p.at)
    if (at === null) invalid(`读不懂时间「${p.at}」：要带时差的 ISO 8601，例如 2026-05-02T09:00:00+08:00`)
    return { cron: null, at, timeZone, rule: null }
  }

  const recurringSchedule = (p: ScheduleParam, rule: ScheduleRule | null, timeZone: string): Schedule => {
    if (rule !== null) return { cron: compatCronOf(rule), at: null, timeZone, rule }
    if (p.cron === undefined) invalid('schedule.type 为 cron 时必须给 schedule.cron，或给 intervalUnit+interval')
    return { cron: p.cron, at: null, timeZone, rule: null }
  }

  const scheduleOf = (p: ScheduleParam, timeZone: string): Schedule => {
    const rule = ruleOf(p, timeZone)
    if (p.type === 'manual') return manualSchedule(rule, timeZone)
    if (p.type === 'once') return onceSchedule(p, rule, timeZone)
    return recurringSchedule(p, rule, timeZone)
  }

  const endAtOf = (text: string | undefined): number | null => {
    if (text === undefined) return null
    const at = parseIsoWithOffset(text)
    if (at === null) invalid(`读不懂截止时间「${text}」：要带时差的 ISO 8601，例如 2026-06-30T23:59:59+08:00`)
    return at
  }

  const limitsOf = (params: {
    readonly recurring?: boolean | undefined
    readonly maxRuns?: number | undefined
    readonly endAt?: string | undefined
  }): { readonly maxRuns: number | null; readonly endAt: number | null } => {
    const endAt = endAtOf(params.endAt)
    if (params.recurring === false) return { maxRuns: params.maxRuns ?? 1, endAt }
    if (params.maxRuns !== undefined) invalid('maxRuns 只能与 recurring=false 一起用')
    return { maxRuns: null, endAt }
  }

  const patchLimitsOf = (
    params: {
      readonly recurring?: boolean | undefined
      readonly maxRuns?: number | undefined
      readonly endAt?: string | undefined
    },
    current: Automation,
  ): { readonly maxRuns: number | null | undefined; readonly endAt: number | null | undefined } => {
    if (params.recurring === undefined) {
      if (params.maxRuns !== undefined) invalid('maxRuns 只能与 recurring=false 一起用')
      return { maxRuns: undefined, endAt: endAtOf(params.endAt) ?? undefined }
    }
    const maxRuns = params.recurring ? null : (params.maxRuns ?? 1)
    return { maxRuns, endAt: endAtOf(params.endAt) ?? current.endAt }
  }

  const assertModel = async (model: ModelRef | null, thinking: string | null): Promise<void> => {
    let controls: Controls | null = null
    if (model !== null) {
      controls = await agentRuntime.draftControls({ model })
      const choices = controls.model.choices.map((c) => refText(c.ref))
      if (!choices.includes(refText(model))) {
        invalid(`模型「${refText(model)}」不可用。可选：${choices.join('、') || '（没有可用模型）'}`)
      }
    }
    if (thinking !== null) {
      controls ??= await agentRuntime.draftControls({ model })
      const levels = controls.thinking.choices.map((c) => c.id)
      if (levels.length > 0 && !levels.includes(thinking)) {
        invalid(`思考强度「${thinking}」不在这个模型的档位里。可选：${levels.join('、')}`)
      }
    }
  }

  const assertNotInRun = (sessionKey: string): void => {
    if (service.inRun(sessionKey)) {
      throw new AppError(
        automationsErrors.forbidden_in_run,
        '定时任务运行中不能创建、修改、删除或手动运行定时任务；需要用户处理的事请写进 automation_report',
      )
    }
  }

  const currentWorkspaceOf = (sessionKey: string): string | null => conversation.get(sessionKey)?.workspaceId ?? null

  const threadOf = (
    thread: SettingsParams['thread'],
    sessionKey: string,
    workspaceId: string,
    current: Automation | null,
  ): Pick<AutomationDraft, 'threadMode' | 'threadId'> | null => {
    if (thread === undefined) return null
    if (thread === 'new') return { threadMode: 'new', threadId: null }
    if (thread === 'continue') {
      const keep = current !== null && current.threadMode === 'continue' ? current.threadId : null
      return { threadMode: 'continue', threadId: keep }
    }
    if (currentWorkspaceOf(sessionKey) !== workspaceId) {
      invalid('thread 为 "this" 时任务必须在这条对话的工作区里运行：不要传别的 workspaceId')
    }
    return { threadMode: 'continue', threadId: sessionKey }
  }

  const scheduleUpdateOf = (params: z.output<typeof updateParams>, current: Automation): Schedule | undefined => {
    const timeZone = params.timeZone ?? current.schedule.timeZone
    if (params.schedule !== undefined) return scheduleOf(params.schedule, timeZone)
    if (params.timeZone !== undefined) return { ...current.schedule, timeZone }
    return undefined
  }

  const patchOf = async (
    params: z.output<typeof updateParams>,
    current: Automation,
    sessionKey: string,
  ): Promise<AutomationPatch> => {
    if (params.workspaceId !== undefined) workspaces.requireUsable(params.workspaceId)
    if (params.model !== undefined || params.thinking !== undefined) {
      await assertModel(
        params.model === undefined ? current.model : params.model,
        params.thinking === undefined ? current.thinking : params.thinking,
      )
    }
    const schedule = scheduleUpdateOf(params, current)
    const thread = threadOf(params.thread, sessionKey, params.workspaceId ?? current.workspaceId, current)
    return {
      title: params.title,
      prompt: params.prompt,
      schedule,
      workspaceId: params.workspaceId,
      posture: params.posture,
      model: params.model,
      thinking: params.thinking,
      threadMode: thread?.threadMode,
      threadId: thread?.threadId,
      notify: params.notify,
      catchUp: params.catchUp,
      ...patchLimitsOf(params, current),
    }
  }

  tools.register({
    name: 'automation_options',
    label: '定时任务可选项',
    description:
      "Everything needed to set up an automation: the user's current time and time zone, the workspaces, the models and thinking levels, and the approval postures. Call this before automation_create when you need a workspace, model, thinking level or a one-time date.",
    parameters: optionsParams,
    approval: 'read',
    async execute(params: z.output<typeof optionsParams>, ctx) {
      const timeZone = d.localTimeZone()
      const controls = await agentRuntime.draftControls(params.model === undefined ? {} : { model: params.model })
      const current = currentWorkspaceOf(ctx.sessionKey)
      return json({
        now: isoIn(d.clock.now(), timeZone),
        timeZone,
        currentWorkspaceId: current,
        workspaces: workspaces.list().map((w) => ({ id: w.id, name: w.name, path: w.path, usable: w.exists })),
        models: controls.model.choices.map((c) => ({ provider: c.ref.provider, id: c.ref.id, label: c.label })),
        defaultModel: controls.model.current,
        thinkingLevels: controls.thinking.choices,
        postures: Object.values(POSTURE_TEXT),
      })
    },
  })

  tools.register({
    name: 'automation_list',
    label: '列出定时任务',
    description:
      'List automations (all workspaces unless workspaceId is given), with schedule, next run, settings and the result of the last run.',
    parameters: listParams,
    approval: 'read',
    async execute(params: z.output<typeof listParams>, ctx) {
      const labels = await modelLabels()
      const rows = service
        .list()
        .filter((a) => params.workspaceId === undefined || a.workspaceId === params.workspaceId)
        .map((a) => viewOf(a, ctx.sessionKey, labels))
      return json(rows)
    },
  })

  tools.register({
    name: 'automation_runs',
    label: '定时任务运行记录',
    description:
      'Recent runs of one automation, newest first: outcome, the summary the run reported, error message, and the conversation id of each run.',
    parameters: runsParams,
    approval: 'read',
    async execute(params: z.output<typeof runsParams>) {
      try {
        const a = service.get(params.id)
        return json({
          id: a.id,
          title: a.title,
          runs: service.runs(a.id, params.limit ?? 5).map((r) => runView(r, a.schedule.timeZone)),
        })
      } catch (e) {
        return chinese(e)
      }
    },
  })

  tools.register({
    name: 'automation_create',
    label: '创建定时任务',
    description:
      'Create an automation: at the scheduled time (or once, or only by hand) an agent runs `prompt` in the chosen workspace with the chosen model, unattended. Returns the automation with its next three run times — tell the user when it will first run.',
    parameters: createParams,
    approval: 'write',
    async execute(params: z.output<typeof createParams>, ctx) {
      try {
        assertNotInRun(ctx.sessionKey)
        const workspaceId = params.workspaceId ?? currentWorkspaceOf(ctx.sessionKey)
        if (workspaceId === null) invalid('找不到当前对话所在的工作区：请传 workspaceId（见 automation_options）')
        workspaces.requireUsable(workspaceId)
        const model = params.model ?? null
        const thinking = params.thinking ?? null
        await assertModel(model, thinking)
        const thread = threadOf(params.thread, ctx.sessionKey, workspaceId, null)
        const created = service.create({
          title: params.title,
          prompt: params.prompt,
          schedule: scheduleOf(params.schedule, params.timeZone ?? d.localTimeZone()),
          workspaceId,
          posture: params.posture ?? 'auto-edit',
          model,
          thinking,
          threadMode: thread?.threadMode ?? 'new',
          threadId: thread?.threadId ?? null,
          notify: params.notify ?? 'attention',
          catchUp: params.catchUp ?? true,
          ...limitsOf(params),
        })
        return json(await detailOf(created, ctx.sessionKey))
      } catch (e) {
        return chinese(e)
      }
    },
  })

  tools.register({
    name: 'automation_update',
    label: '修改定时任务',
    description:
      'Change an automation by id. Only the fields you pass change. Pass enabled=false to pause and enabled=true to resume.',
    parameters: updateParams,
    approval: 'write',
    async execute(params: z.output<typeof updateParams>, ctx) {
      try {
        assertNotInRun(ctx.sessionKey)
        const patch = await patchOf(params, service.get(params.id), ctx.sessionKey)
        let updated = service.update(params.id, patch)
        if (params.enabled !== undefined && params.enabled !== updated.enabled) {
          updated = service.setEnabled(params.id, params.enabled)
        }
        return json(await detailOf(updated, ctx.sessionKey))
      } catch (e) {
        return chinese(e)
      }
    },
  })

  tools.register({
    name: 'automation_run',
    label: '立即运行定时任务',
    description: 'Run an automation once right now, in the background. Returns the run and its conversation id.',
    parameters: idParams,
    approval: 'write',
    async execute(params: z.output<typeof idParams>, ctx) {
      try {
        assertNotInRun(ctx.sessionKey)
        const a = service.get(params.id)
        const run = await service.runNow(a.id)
        return json({ id: a.id, title: a.title, run: runView(run, a.schedule.timeZone) })
      } catch (e) {
        return chinese(e)
      }
    },
  })

  tools.register({
    name: 'automation_delete',
    label: '删除定时任务',
    description: 'Delete an automation by id (a running run is stopped first; its conversations are kept).',
    parameters: idParams,
    approval: 'write',
    async execute(params: z.output<typeof idParams>, ctx) {
      try {
        assertNotInRun(ctx.sessionKey)
        const a = service.get(params.id)
        await service.remove(a.id)
        return json({ id: a.id, title: a.title, removed: true })
      } catch (e) {
        return chinese(e)
      }
    },
  })

  tools.register({
    name: 'automation_pause_self',
    label: '暂停这个定时任务',
    description:
      'Only during an automation run: pause the automation that started this conversation. The current run continues; no future runs start. Use it when the task no longer needs to repeat.',
    parameters: z.object({}),
    approval: 'write',
    async execute(_params, ctx) {
      try {
        const paused = service.pauseSelf(ctx.sessionKey)
        return json({ id: paused.id, title: paused.title, enabled: paused.enabled })
      } catch (e) {
        return chinese(e)
      }
    },
  })

  tools.register({
    name: 'automation_report',
    label: '汇报定时任务结果',
    description:
      'Only during an automation run: record the conclusion of this run. Call it once, at the end, before your final reply. Set attention=true when the user should look at it.',
    parameters: reportParams,
    approval: 'read',
    async execute(params: z.output<typeof reportParams>, ctx) {
      try {
        service.report(ctx.sessionKey, params.summary, params.attention ?? false)
        return json({ reported: true, summary: params.summary, attention: params.attention ?? false })
      } catch (e) {
        return chinese(e)
      }
    },
  })
}
