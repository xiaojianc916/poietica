import type { AgentToolRegistry } from '@poietica/core-kernel'
import type { AgentEngine, Controls, ModelRef, Posture } from '@poietica/engine'
import type { ConversationService } from '@poietica/feature-conversation/core-api'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { AppError, type Clock, SystemErrorCode } from '@poietica/foundation'
import { z } from 'zod'
import type { Automation, AutomationDraft, AutomationRun, Schedule } from '../contract/entities'
import { automationsErrors } from '../contract/errors'
import type { AutomationPatch, AutomationsService } from './service'
import { isoIn, parseIsoWithOffset } from './time'

/*
 * 定时任务的 agent 工具（审查 R-15）。
 *
 * 一共八张：automation_options / list / runs / create / update / run / delete / report。
 * 设计要点：
 *   - 时间一律是带时差的 ISO 8601，时区默认用户本机时区 —— 模型不用猜；
 *   - 工作区、模型、思考强度都能选，可选值由 automation_options 一次给全，传错了报中文错误并列出可选值；
 *   - 结果是 JSON 文本：同一份既给模型读，也给对话里的工具卡片画（automation-tool-card.tsx）；
 *   - 定时任务**运行中**（这条对话上有开着的运行）只许 options / list / runs / report：
 *     不许建、改、删、手动运行任务，防止任务自我繁殖或改写自己。
 *
 * 参数表单独命名（而不是内联进 tools.register）是为了让 execute 的 params 有确切类型。
 */

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
})

const updateParams = z.object({
  id: z.string().min(1).describe('Automation id'),
  title: createParams.shape.title.optional(),
  prompt: createParams.shape.prompt.optional(),
  schedule: scheduleParam.optional(),
  ...settingsShape,
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
  readonly engine: Pick<AgentEngine, 'draftControls'>
  readonly clock: Clock
  readonly localTimeZone: () => string
}): void {
  const { conversation, engine, service, tools, workspaces } = d

  /* ── 读法：交给模型、也交给卡片的那几格 ─────────────────────────────── */

  const iso = (at: number | null, timeZone: string): string | null => (at === null ? null : isoIn(at, timeZone))

  const scheduleView = (s: Schedule) =>
    s.cron !== null
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
    const controls = await engine.draftControls({})
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
    issue: a.issue,
    lastRun: a.lastRun === null ? null : runView(a.lastRun, a.schedule.timeZone),
  })

  /** 新建、修改之后多给接下来三次的运行时间：agent 拿它跟用户确认「下次是明早 9 点」 */
  const detailOf = async (a: Automation, sessionKey: string) => ({
    ...viewOf(a, sessionKey, await modelLabels()),
    upcoming: service.previewSchedule(a.schedule, 3).times.map((t) => isoIn(t, a.schedule.timeZone)),
  })

  /* ── 写法：工具参数 → 契约草稿 ──────────────────────────────────────── */

  const scheduleOf = (p: ScheduleParam, timeZone: string): Schedule => {
    if (p.type === 'manual') return { cron: null, at: null, timeZone }
    if (p.type === 'cron') {
      if (p.cron === undefined) invalid('schedule.type 为 cron 时必须给 schedule.cron（例如 "0 9 * * 1-5"）')
      return { cron: p.cron, at: null, timeZone }
    }
    if (p.at === undefined) invalid('schedule.type 为 once 时必须给 schedule.at（带时差的 ISO 8601）')
    const at = parseIsoWithOffset(p.at)
    if (at === null) invalid(`读不懂时间「${p.at}」：要带时差的 ISO 8601，例如 2026-05-02T09:00:00+08:00`)
    return { cron: null, at, timeZone }
  }

  /** 模型与思考强度只收可选表里有的：传错了把可选值列给模型，它下一次就能传对 */
  const assertModel = async (model: ModelRef | null, thinking: string | null): Promise<void> => {
    let controls: Controls | null = null
    if (model !== null) {
      controls = await engine.draftControls({ model })
      const choices = controls.model.choices.map((c) => refText(c.ref))
      if (!choices.includes(refText(model))) {
        invalid(`模型「${refText(model)}」不可用。可选：${choices.join('、') || '（没有可用模型）'}`)
      }
    }
    if (thinking !== null) {
      controls ??= await engine.draftControls({ model })
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

  /** thread 参数 → 续用模式与续用哪条；'this' 要求任务就在这条对话的工作区里 */
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

  /** 改计划或只改时区；都没给是 undefined（不改） */
  const scheduleUpdateOf = (params: z.output<typeof updateParams>, current: Automation): Schedule | undefined => {
    const timeZone = params.timeZone ?? current.schedule.timeZone
    if (params.schedule !== undefined) return scheduleOf(params.schedule, timeZone)
    if (params.timeZone !== undefined) return { ...current.schedule, timeZone }
    return undefined
  }

  /** automation_update 的参数 → 服务层 patch：只带给了的字段，并逐项校验（工作区、模型、计划、续用） */
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
    }
  }

  /* ── 工具 ──────────────────────────────────────────────────────────── */

  tools.register({
    name: 'automation_options',
    label: '定时任务可选项',
    description:
      "Everything needed to set up an automation: the user's current time and time zone, the workspaces, the models and thinking levels, and the approval postures. Call this before automation_create when you need a workspace, model, thinking level or a one-time date.",
    parameters: optionsParams,
    approval: 'read',
    async execute(params: z.output<typeof optionsParams>, ctx) {
      const timeZone = d.localTimeZone()
      const controls = await engine.draftControls(params.model === undefined ? {} : { model: params.model })
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
