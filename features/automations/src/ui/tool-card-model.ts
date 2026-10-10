import { describeSchedule } from './automation'

/*
 * 对话里「定时任务」工具卡的读法（审查 R-16）：工具调用 → 一份只读的卡片模型。
 *
 * 纯函数、不碰 React：卡片长什么样由 automation-tool-card.tsx 画，「这一次调用说了什么」
 * 只在这里判一次，测试直接验它。输入是 conversation 交来的三样东西：
 *   - args   —— 模型传进来的参数（「已修改：…」读它给了哪些键）；
 *   - result —— 工具结果（R-15 的 JSON 文本，字段名见 R-15 §3.3）；
 *   - status —— running / succeeded / failed。
 *
 * 读不出来的一律退回「只有一行」，不编造字段。
 */

export type ToolStatus = 'running' | 'succeeded' | 'failed'
export type Tone = 'quiet' | 'success' | 'warning' | 'danger'

export interface CardAutomation {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly enabled: boolean
  /** 「每工作日 09:00」「一次 · 05-02 09:00」「仅手动运行」 */
  readonly plan: string
  /** 下一次的绝对时刻（毫秒）；没有就是 null */
  readonly nextRunAt: number | null
  readonly state: { readonly label: string; readonly tone: Tone }
  readonly meta: readonly { readonly label: string; readonly value: string }[]
  readonly upcoming: readonly string[]
  readonly issue: string | null
  readonly timeZone: string
  /** 一次性：计划那句已经写了时刻，「下次」只补相对时间 */
  readonly once: boolean
}

export interface CardListRow {
  readonly id: string
  readonly title: string
  readonly plan: string
  readonly tone: Tone
  readonly last: string | null
  /** 上次失败时行尾那句用危险色 */
  readonly lastTone: Tone
}

export interface CardRunRow {
  readonly id: string
  readonly glyph: RunGlyph
  readonly when: string
  readonly tag: string | null
  readonly text: string | null
  readonly threadId: string | null
}

export type RunGlyph = 'succeeded' | 'failed' | 'running' | 'awaiting' | 'cancelled' | 'skipped'

export type CardBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'automation'; readonly automation: CardAutomation; readonly changed: readonly string[] }
  | { readonly kind: 'list'; readonly rows: readonly CardListRow[]; readonly more: number }
  | { readonly kind: 'runs'; readonly automationId: string; readonly rows: readonly CardRunRow[] }
  | { readonly kind: 'report'; readonly summary: string; readonly attention: boolean }
  | { readonly kind: 'run'; readonly automationId: string; readonly threadId: string | null }

export interface ToolCardModel {
  /** 行里那句话：动作 + 对象 */
  readonly line: string
  /** 行尾的小字（数量、计划）；没有就是 null */
  readonly hint: string | null
  readonly status: ToolStatus
  /** 失败时的那句原话 */
  readonly error: string | null
  readonly body: CardBody
}

/* ── 词表 ──────────────────────────────────────────────────────────────── */

const VERBS: Readonly<Record<string, readonly [running: string, done: string]>> = {
  automation_options: ['正在查看定时任务可选项', '查看了定时任务可选项'],
  automation_list: ['正在列出定时任务', '列出了定时任务'],
  automation_runs: ['正在查看运行记录', '查看了运行记录'],
  automation_create: ['正在创建定时任务', '创建了定时任务'],
  automation_update: ['正在修改定时任务', '修改了定时任务'],
  automation_run: ['正在启动定时任务', '启动了定时任务'],
  automation_delete: ['正在删除定时任务', '删除了定时任务'],
  automation_report: ['正在汇报本次结果', '汇报了本次结果'],
}

const FAILED_VERBS: Readonly<Record<string, string>> = {
  automation_options: '查看定时任务可选项失败',
  automation_list: '列出定时任务失败',
  automation_runs: '查看运行记录失败',
  automation_create: '创建定时任务失败',
  automation_update: '修改定时任务失败',
  automation_run: '启动定时任务失败',
  automation_delete: '删除定时任务失败',
  automation_report: '汇报本次结果失败',
}

const THREAD_TEXT: Readonly<Record<string, string>> = {
  new: '每次新开',
  continue: '续用同一条',
  this: '续用这条对话',
}

const NOTIFY_TEXT: Readonly<Record<string, string>> = {
  always: '每次都通知',
  attention: '需要关注时',
  never: '不通知',
}

const POSTURE_TEXT: Readonly<Record<string, string>> = {
  ask: '每次询问',
  'auto-edit': '自动编辑',
  'full-access': '完全放行',
}

const THINKING_TEXT: Readonly<Record<string, string>> = {
  off: '不思考',
  minimal: '极少思考',
  low: '浅度思考',
  medium: '中度思考',
  high: '深度思考',
  xhigh: '极深思考',
}

/** update 的参数键 → 「已修改：…」里的说法；id / enabled 另说 */
const FIELD_TEXT: Readonly<Record<string, string>> = {
  title: '标题',
  prompt: '指令',
  schedule: '计划',
  timeZone: '时区',
  workspaceId: '工作区',
  model: '模型',
  thinking: '思考强度',
  posture: '权限',
  thread: '对话方式',
  notify: '通知',
  catchUp: '错过补跑',
}

const TRIGGER_TAG: Readonly<Record<string, string>> = {
  manual: '手动',
  catch_up: '补跑',
}

/* ── 安全读取 ───────────────────────────────────────────────────────────── */

type Bag = Readonly<Record<string, unknown>>

function bag(value: unknown): Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Bag) : {}
}

function str(value: unknown, key: string): string | null {
  const raw = bag(value)[key]
  return typeof raw === 'string' && raw !== '' ? raw : null
}

function bool(value: unknown, key: string): boolean | null {
  const raw = bag(value)[key]
  return typeof raw === 'boolean' ? raw : null
}

/**
 * 工具结果的正文：引擎交来的可能是 `{text}`、`{content:[{type:'text',text}]}`，
 * 也可能直接是字符串。三种都认，别的形状一律当没有正文。
 */
export function resultText(result: unknown): string | null {
  if (typeof result === 'string') return result
  const direct = str(result, 'text')
  if (direct !== null) return direct
  const content = bag(result).content
  if (!Array.isArray(content)) return null
  const texts = content.flatMap((part) => {
    const text = str(part, 'text')
    return bag(part).type === 'text' && text !== null ? [text] : []
  })
  return texts.length === 0 ? null : texts.join('\n')
}

function parsed(result: unknown): unknown {
  const text = resultText(result)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** 失败那一句：结果里的 error / message，或读不成 JSON 的正文本身 */
function errorOf(result: unknown): string | null {
  const explicit = str(result, 'error') ?? str(result, 'message')
  if (explicit !== null) return explicit
  const text = resultText(result)
  if (text === null) return null
  const json = parsed(result)
  return json === null ? text : (str(json, 'message') ?? str(json, 'error') ?? text)
}

/* ── 时间 ──────────────────────────────────────────────────────────────── */

const pad = (n: number): string => String(n).padStart(2, '0')

/** ISO（带时差）或毫秒 → 「MM-DD HH:mm」，按给定时区读；读不懂返回 null */
export function clockText(at: string | number, timeZone: string | null = null): string | null {
  const ms = typeof at === 'number' ? at : Date.parse(at)
  if (!Number.isFinite(ms)) return null
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone === null || timeZone === '' ? {} : { timeZone }),
    }).formatToParts(new Date(ms))
    const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
    return `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
  } catch {
    const d = new Date(ms)
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}

/* ── 一条任务 ──────────────────────────────────────────────────────────── */

export function planOf(schedule: unknown): string {
  const type = str(schedule, 'type')
  const timeZone = str(schedule, 'timeZone')
  if (type === 'cron') return describeSchedule(str(schedule, 'cron'))
  if (type === 'once') {
    const at = str(schedule, 'at')
    const when = at === null ? null : clockText(at, timeZone)
    return when === null ? '一次' : `一次 · ${when}`
  }
  return '仅手动运行'
}

function stateOf(view: unknown): { label: string; tone: Tone } {
  if (str(view, 'issue') !== null) return { label: '计划有问题', tone: 'warning' }
  const outcome = str(bag(view).lastRun, 'outcome')
  if (outcome === 'running') return { label: '运行中', tone: 'success' }
  if (outcome === 'awaiting') return { label: '等待批准', tone: 'warning' }
  if (bool(view, 'enabled') === false) {
    return str(bag(view).schedule, 'type') === 'once' && str(view, 'nextRunAt') === null
      ? { label: '已完成', tone: 'quiet' }
      : { label: '已暂停', tone: 'quiet' }
  }
  if (str(bag(view).schedule, 'type') === 'manual') return { label: '手动', tone: 'quiet' }
  return { label: '已启用', tone: 'success' }
}

function modelText(view: unknown): string {
  const model = bag(view).model
  const name =
    model === null || model === undefined ? '默认模型' : (str(model, 'label') ?? str(model, 'id') ?? '默认模型')
  const thinking = str(view, 'thinking')
  return thinking === null ? name : `${name} · ${THINKING_TEXT[thinking] ?? `思考 ${thinking}`}`
}

function metaOf(view: unknown): CardAutomation['meta'] {
  const workspace = bag(view).workspace
  const thread = str(view, 'thread') ?? 'new'
  const notify = str(view, 'notify') ?? 'attention'
  const posture = str(view, 'posture') ?? 'auto-edit'
  return [
    { label: '工作区', value: str(workspace, 'name') ?? str(workspace, 'id') ?? '—' },
    { label: '模型', value: modelText(view) },
    { label: '对话', value: THREAD_TEXT[thread] ?? thread },
    { label: '通知', value: NOTIFY_TEXT[notify] ?? notify },
    { label: '权限', value: POSTURE_TEXT[posture] ?? posture },
  ]
}

export function automationOf(view: unknown): CardAutomation | null {
  const id = str(view, 'id')
  const title = str(view, 'title')
  if (id === null || title === null) return null
  const schedule = bag(view).schedule
  const timeZone = str(schedule, 'timeZone') ?? ''
  const next = str(view, 'nextRunAt')
  const upcomingRaw = bag(view).upcoming
  const upcoming = Array.isArray(upcomingRaw)
    ? upcomingRaw.flatMap((t) => {
        const text = typeof t === 'string' ? clockText(t, timeZone) : null
        return text === null ? [] : [text]
      })
    : []
  return {
    id,
    title,
    prompt: str(view, 'prompt') ?? '',
    enabled: bool(view, 'enabled') ?? true,
    plan: planOf(schedule),
    nextRunAt: next === null ? null : Number.isFinite(Date.parse(next)) ? Date.parse(next) : null,
    state: stateOf(view),
    meta: metaOf(view),
    upcoming,
    issue: str(view, 'issue'),
    timeZone,
    once: str(schedule, 'type') === 'once',
  }
}

/** update 的参数里给了哪些键 → 「标题、模型」；enabled 说成「暂停 / 恢复」 */
export function changedOf(args: unknown): readonly string[] {
  const given = bag(args)
  const out: string[] = []
  for (const [key, text] of Object.entries(FIELD_TEXT)) {
    if (given[key] !== undefined) out.push(text)
  }
  if (given.enabled === false) out.push('暂停')
  if (given.enabled === true) out.push('恢复')
  return out
}

/* ── 列表与运行 ─────────────────────────────────────────────────────────── */

const LIST_LIMIT = 6

const LAST_TEXT: Readonly<Record<string, string>> = {
  succeeded: '上次成功',
  failed: '上次失败',
  cancelled: '上次已取消',
  skipped: '上次跳过',
  running: '运行中',
  awaiting: '等待批准',
}

function listRowOf(view: unknown): CardListRow | null {
  const automation = automationOf(view)
  if (automation === null) return null
  const outcome = str(bag(view).lastRun, 'outcome')
  return {
    id: automation.id,
    title: automation.title,
    plan: automation.plan,
    tone: automation.state.tone,
    last: outcome === null ? null : (LAST_TEXT[outcome] ?? null),
    lastTone: outcome === 'failed' ? 'danger' : outcome === 'awaiting' ? 'warning' : 'quiet',
  }
}

const GLYPHS: readonly RunGlyph[] = ['succeeded', 'failed', 'running', 'awaiting', 'cancelled', 'skipped']

export function runRowOf(run: unknown, timeZone: string | null): CardRunRow | null {
  const id = str(run, 'id')
  const outcome = str(run, 'outcome')
  if (id === null || outcome === null) return null
  const glyph = GLYPHS.find((g) => g === outcome) ?? 'cancelled'
  const started = str(run, 'startedAt')
  const trigger = str(run, 'trigger')
  return {
    id,
    glyph,
    when: (started === null ? null : clockText(started, timeZone)) ?? '—',
    tag: trigger === null ? null : (TRIGGER_TAG[trigger] ?? null),
    text: str(run, 'summary') ?? str(run, 'message'),
    threadId: str(run, 'threadId'),
  }
}

/* ── 总入口 ────────────────────────────────────────────────────────────── */

function lineOf(toolName: string, status: ToolStatus, subject: string | null): string {
  const verbs = VERBS[toolName]
  const verb =
    status === 'failed'
      ? (FAILED_VERBS[toolName] ?? toolName)
      : verbs === undefined
        ? toolName
        : verbs[status === 'running' ? 0 : 1]
  return subject === null ? verb : `${verb} · ${subject}`
}

function listBody(json: unknown): CardBody {
  const rows = (Array.isArray(json) ? json : []).flatMap((v) => {
    const row = listRowOf(v)
    return row === null ? [] : [row]
  })
  return { kind: 'list', rows: rows.slice(0, LIST_LIMIT), more: Math.max(0, rows.length - LIST_LIMIT) }
}

function runsBody(json: unknown): CardBody {
  const raw = bag(json).runs
  const rows = (Array.isArray(raw) ? raw : []).flatMap((r) => {
    const row = runRowOf(r, null)
    return row === null ? [] : [row]
  })
  return { kind: 'runs', automationId: str(json, 'id') ?? '', rows }
}

function bodyOf(toolName: string, args: unknown, json: unknown): CardBody {
  switch (toolName) {
    case 'automation_create':
    case 'automation_update': {
      const automation = automationOf(json)
      if (automation === null) return { kind: 'none' }
      return { kind: 'automation', automation, changed: toolName === 'automation_update' ? changedOf(args) : [] }
    }
    case 'automation_list':
      return listBody(json)
    case 'automation_runs':
      return runsBody(json)
    case 'automation_report': {
      const summary = str(json, 'summary') ?? str(args, 'summary')
      if (summary === null) return { kind: 'none' }
      return { kind: 'report', summary, attention: (bool(json, 'attention') ?? bool(args, 'attention')) === true }
    }
    case 'automation_run': {
      const id = str(json, 'id')
      if (id === null) return { kind: 'none' }
      return { kind: 'run', automationId: id, threadId: str(bag(json).run, 'threadId') }
    }
    default:
      return { kind: 'none' }
  }
}

function hintOf(toolName: string, json: unknown): string | null {
  if (toolName === 'automation_list' && Array.isArray(json)) return `${json.length} 个`
  if (toolName === 'automation_runs') {
    const runs = bag(json).runs
    return Array.isArray(runs) ? `最近 ${runs.length} 次` : null
  }
  if (toolName === 'automation_options') {
    const ws = bag(json).workspaces
    const models = bag(json).models
    if (!Array.isArray(ws) || !Array.isArray(models)) return null
    return `${ws.length} 个工作区 · ${models.length} 个模型`
  }
  return null
}

function subjectOf(toolName: string, args: unknown, json: unknown): string | null {
  if (toolName === 'automation_list' || toolName === 'automation_options' || toolName === 'automation_report') {
    return null
  }
  return str(json, 'title') ?? str(args, 'title')
}

export function toolCardOf(toolName: string, args: unknown, result: unknown, status: ToolStatus): ToolCardModel {
  if (status !== 'succeeded') {
    return {
      line: lineOf(toolName, status, str(args, 'title')),
      hint: null,
      status,
      error: status === 'failed' ? errorOf(result) : null,
      body: { kind: 'none' },
    }
  }
  const json = parsed(result)
  return {
    line: lineOf(toolName, status, subjectOf(toolName, args, json)),
    hint: hintOf(toolName, json),
    status,
    error: null,
    body: bodyOf(toolName, args, json),
  }
}
