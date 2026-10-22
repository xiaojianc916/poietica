import type { SlashCommand } from '@poietica/engine'
import type { SlashCommandContribution } from '../../ui-api'
import { PLAN_CONTROL_ID, PLAN_ENABLED } from '../session'
import {
  COMMAND_GROUPS,
  type CommandChoice,
  type CommandGroupId,
  type CommandInput,
  type ComposerCommand,
  findCommand,
} from '../shared/model/commands'
import type { SessionConfigControl } from '../shared/model/config'
import type { ChatStatus } from '../shared/model/run'

/*
 * GUI 里的斜杠命令清单：哪些列、在哪儿列、选中之后做什么，都在这一处。
 *
 * 为什么不再「omp 有什么就列什么」：omp 的命令是为终端写的 —— 结果是一段英文、参数靠记、很多条在 GUI 里根本办不到
 * （`/ssh`、`/changelog`、`/dirs`……）。原先全量照搬，结果是入口页敲一条 `/model` 就建出一条空对话、
 * 敲 `/rename` 把「自动生成标题」截成了「打开改名框」、结果全挤进输入框上方那一块。现在的规矩：
 *   1. 清单里没有的内置命令一律不列（手打也不执行，横幅说一句）；omp 新加一条命令，先在这里写清楚 GUI 怎么办再放出来。
 *   2. 能落到现成界面的就落到界面：`/model` 开模型选择器、`/mcp` 开 MCP 设置页、`/export` 走导出对话框 ——
 *      敲命令等于点那个控件，不回一句「当前模型：…」。
 *   3. 只有 omp 才办得到的（压缩、交接、快速模式……）才交给 omp，并且只在它办得到的时候列：
 *      引擎只在空闲时收命令（engine.busy），入口页还没有会话 —— 这两种时候这些命令不出现。
 * 用户写的命令（文件命令、扩展命令、MCP 提示词）照 omp 的表全列：它们是交给模型的一段话，入口页按发送时才建对话。
 */

/** 命令此刻所在的场所：入口页（还没有对话）/ 对话空闲 / 对话正在跑 */
export type CommandPlace = 'draft' | 'idle' | 'busy'

/** 由 conversation 自己办的那几条（打开控件、走现成动作），不经 omp */
export type NativeAction =
  | 'new'
  | 'fork'
  | 'rename'
  | 'context'
  | 'export'
  | 'share'
  | 'plan'
  | 'model'
  | 'effort'
  | 'settings'
  | 'todo'

/**
 * 选中之后怎么执行：
 * - engine：原句交给 omp（只在对话空闲时）；
 * - prompt：交给 omp 展开成一段话发给模型（入口页也能用：发送时才建对话）；
 * - native：conversation 自己办；
 * - contributed：别的功能贡献的（打开它的设置页）。
 */
export type CommandEffect =
  | { readonly kind: 'engine' }
  | { readonly kind: 'prompt' }
  | { readonly kind: 'native'; readonly action: NativeAction }
  | { readonly kind: 'contributed'; readonly run: () => void }

/** 面板能画、表面能执行的一条命令 */
export interface AvailableCommand extends ComposerCommand {
  readonly effect: CommandEffect
}

/** 清单要看的那几样此刻的事实 */
export interface CommandContext {
  readonly place: CommandPlace
  /** omp 此刻的命令表（入口页是不开会话的目录） */
  readonly engine: readonly SlashCommand[]
  readonly contributed: readonly SlashCommandContribution[]
  readonly controls: readonly SessionConfigControl[]
  readonly status: ChatStatus
  /** 这一格有没有对应的动作 / 浮层（没接的不列） */
  readonly can: {
    readonly rename: boolean
    readonly export: boolean
    readonly share: boolean
    readonly context: boolean
    readonly todo: boolean
  }
}

/** 一条内置命令在 GUI 里的写法 */
interface BuiltinSpec {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly group: CommandGroupId
  readonly description: string
  readonly places: readonly CommandPlace[]
  /** 要 omp 的表里有这一条才列（omp 关掉 / 没有这条命令时不画一个点了没反应的入口） */
  readonly engine?: true
  readonly effect: CommandEffect
  readonly input?: CommandInput | ((context: CommandContext) => CommandInput)
  /** 场所之外的前提；不满足时交回为什么（手打时横幅说这一句），满足交回 null */
  readonly blocked?: (context: CommandContext) => string | null
}

const ON_OFF: readonly CommandChoice[] = [
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' },
  { value: 'status', label: '查看当前状态' },
]

const ALWAYS: readonly CommandPlace[] = ['draft', 'idle', 'busy']
const IN_THREAD: readonly CommandPlace[] = ['idle', 'busy']
const IDLE: readonly CommandPlace[] = ['idle']
const DRAFT_OR_IDLE: readonly CommandPlace[] = ['draft', 'idle']

const optional = (placeholder: string): CommandInput => ({ kind: 'text', required: false, placeholder })
const choice = (choices: readonly CommandChoice[], current?: string): CommandInput => ({
  kind: 'choice',
  choices,
  ...(current === undefined ? {} : { current }),
})

const controlOf = (
  context: CommandContext,
  purpose: SessionConfigControl['purpose'],
): SessionConfigControl | undefined => context.controls.find((control) => control.purpose === purpose)

/* 控件的候选就是选项：/model 的二级列表与模型选择器同一张表，/effort 与档位滑轨同一张表 */
function controlInput(control: SessionConfigControl | undefined): CommandInput {
  if (control === undefined || control.choices.length === 0) return { kind: 'none' }
  return choice(
    control.choices.map((entry) => ({ value: entry.value, label: entry.label })),
    control.current,
  )
}

const unless = (ok: (context: CommandContext) => boolean, reason: string) => (context: CommandContext) =>
  ok(context) ? null : reason

/**
 * 清单本体。次序 = 面板里同组的次序（常用的在前）。名字是 omp 的命令名（同名才能把原句交给它）；
 * 纯 GUI 的几条（/new、/fork、/plan、/settings）omp 没有或不该由它办。
 */
const BUILTINS: readonly BuiltinSpec[] = [
  /* 对话 */
  {
    name: 'new',
    group: 'conversation',
    description: '新建对话',
    places: IN_THREAD,
    effect: { kind: 'native', action: 'new' },
  },
  {
    name: 'fork',
    aliases: ['branch'],
    group: 'conversation',
    description: '从这里分出一条新对话，保留全部上下文',
    places: IN_THREAD,
    effect: { kind: 'native', action: 'fork' },
  },
  {
    name: 'rename',
    group: 'conversation',
    description: '重命名对话；不写标题就按对话内容自动生成',
    places: IN_THREAD,
    effect: { kind: 'native', action: 'rename' },
    input: optional('新标题，留空自动生成'),
    blocked: unless((context) => context.can.rename, '这条对话还不能改名'),
  },
  {
    name: 'compact',
    group: 'conversation',
    description: '把较早的对话压缩成摘要，腾出上下文',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
    input: optional('压缩时要保留的重点，可留空'),
  },
  {
    name: 'handoff',
    group: 'conversation',
    description: '把对话整理成交接摘要，并就地压缩上下文',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
    input: optional('交接重点，可留空'),
  },
  {
    name: 'shake',
    group: 'conversation',
    description: '移除工具输出等大块内容，释放上下文',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
    input: choice([
      { value: 'elide', label: '工具结果与大块内容', detail: '默认' },
      { value: 'images', label: '图片' },
      { value: 'thinking', label: '思考内容' },
    ]),
  },
  {
    name: 'retry',
    group: 'conversation',
    description: '重试上一轮失败的回复',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
    blocked: unless(
      (context) => context.status === 'error' || context.status === 'interrupted',
      '上一轮没有失败，不需要重试',
    ),
  },
  {
    name: 'context',
    group: 'conversation',
    description: '查看上下文用量明细',
    places: IN_THREAD,
    effect: { kind: 'native', action: 'context' },
    blocked: unless((context) => context.can.context, '还没有上下文用量可看'),
  },
  {
    name: 'export',
    group: 'conversation',
    description: '把对话导出为 Markdown 文件',
    places: IN_THREAD,
    effect: { kind: 'native', action: 'export' },
    blocked: unless((context) => context.can.export, '这条对话还不能导出'),
  },
  {
    name: 'share',
    group: 'conversation',
    description: '生成加密的分享链接并复制',
    places: IN_THREAD,
    effect: { kind: 'native', action: 'share' },
    blocked: unless((context) => context.can.share, '这条对话还不能分享'),
  },
  {
    name: 'todo',
    aliases: ['jobs'],
    group: 'conversation',
    description: '查看任务清单与后台任务',
    places: IN_THREAD,
    effect: { kind: 'native', action: 'todo' },
    blocked: unless((context) => context.can.todo, '这里没有任务面板'),
  },
  {
    name: 'fresh',
    group: 'conversation',
    description: '重置与服务商的连接状态，对话记录不变',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
  },
  /* 模式 */
  {
    name: 'plan',
    group: 'mode',
    description: '计划模式：先出方案，批准后再动手',
    places: ALWAYS,
    effect: { kind: 'native', action: 'plan' },
    input: (context) => {
      const plan = context.controls.find((control) => control.id === PLAN_CONTROL_ID)
      return choice(
        [
          { value: 'on', label: '开启' },
          { value: 'off', label: '关闭' },
        ],
        plan === undefined ? undefined : plan.current === PLAN_ENABLED ? 'on' : 'off',
      )
    },
    blocked: unless(
      (context) => context.controls.some((control) => control.id === PLAN_CONTROL_ID),
      '当前模型不支持计划模式',
    ),
  },
  {
    name: 'fast',
    group: 'mode',
    description: '快速模式：服务商的优先档，更快、更贵',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
    input: choice([
      { value: 'on', label: '开启' },
      { value: 'ultra', label: '极速', detail: 'OpenAI 与支持它的 Codex 模型' },
      { value: 'off', label: '关闭' },
      { value: 'status', label: '查看当前状态' },
    ]),
  },
  {
    name: 'slow',
    group: 'mode',
    description: '慢速模式：flex 档或订阅低优先级，更便宜、更慢',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
    input: choice(ON_OFF),
  },
  {
    name: 'extended-context',
    group: 'mode',
    description: '扩展上下文窗口',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
    input: choice(ON_OFF),
  },
  {
    name: 'advisor',
    group: 'mode',
    description: '顾问：另一个模型审阅每一轮并给出建议',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
    input: choice(ON_OFF),
  },
  {
    name: 'skillful',
    group: 'mode',
    description: '在这条对话的系统提示里列出可用技能',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
    input: choice(ON_OFF),
  },
  /* 模型与推理 */
  {
    name: 'model',
    aliases: ['models', 'switch'],
    group: 'model',
    description: '切换模型',
    places: ALWAYS,
    effect: { kind: 'native', action: 'model' },
    input: (context) => controlInput(controlOf(context, 'model')),
  },
  {
    name: 'effort',
    group: 'model',
    description: '推理强度',
    places: ALWAYS,
    effect: { kind: 'native', action: 'effort' },
    input: (context) => controlInput(controlOf(context, 'thought')),
    blocked: unless((context) => controlOf(context, 'thought') !== undefined, '当前模型没有可调的推理强度'),
  },
  {
    name: 'force',
    group: 'model',
    description: '让下一轮必须使用指定工具',
    places: IDLE,
    engine: true,
    effect: { kind: 'engine' },
    input: { kind: 'text', required: true, placeholder: '工具名，后面可接要求' },
  },
  /* 工作流：omp 随包带的几条，展开成一段话交给模型 */
  {
    name: 'review',
    group: 'workflow',
    description: '审查代码改动',
    places: DRAFT_OR_IDLE,
    engine: true,
    effect: { kind: 'prompt' },
    input: optional('审查要求，可留空'),
  },
  {
    name: 'init',
    group: 'workflow',
    description: '为当前项目生成 AGENTS.md',
    places: DRAFT_OR_IDLE,
    engine: true,
    effect: { kind: 'prompt' },
  },
  {
    name: 'green',
    group: 'workflow',
    description: '反复修复 CI 失败，直到分支通过',
    places: DRAFT_OR_IDLE,
    engine: true,
    effect: { kind: 'prompt' },
  },
  {
    name: 'annotate',
    group: 'workflow',
    description: '批注改动、文件或最近一条回复',
    places: DRAFT_OR_IDLE,
    engine: true,
    effect: { kind: 'prompt' },
    input: optional('批注对象，可留空'),
  },
  {
    name: 'ratchet',
    group: 'workflow',
    description: '为一段 LLM 流程建立评测，并自动迭代优化',
    places: DRAFT_OR_IDLE,
    engine: true,
    effect: { kind: 'prompt' },
    input: optional('流程与目标，可留空'),
  },
  /* 设置 */
  {
    name: 'settings',
    aliases: ['config'],
    group: 'settings',
    description: '打开设置',
    places: ALWAYS,
    effect: { kind: 'native', action: 'settings' },
  },
]

const SPEC_BY_NAME: ReadonlyMap<string, BuiltinSpec> = new Map(BUILTINS.map((spec) => [spec.name, spec]))

/** 用户写的命令归哪一组（技能不进这张表：它有输入框的技能标记那一个入口） */
const SOURCE_GROUP: Readonly<Record<Exclude<SlashCommand['source'], 'builtin'>, CommandGroupId>> = {
  file: 'custom',
  custom: 'custom',
  extension: 'extension',
  mcp_prompt: 'mcp',
}

/* omp 的参数提示里 `<…>` 是必填；没有提示也照样能带参数（扩展命令多半不写提示），所以一律给一格可留空的参数 */
function userInput(command: SlashCommand): CommandInput {
  const hint = command.hint?.trim() ?? ''
  if (hint.startsWith('<')) return { kind: 'text', required: true, placeholder: hint.replace(/^<|>$/g, '') }
  return optional(hint === '' ? '参数，可留空' : `${hint.replace(/^\[|\]$/g, '')}，可留空`)
}

const PLACE_REASON: Readonly<Record<CommandPlace, string>> = {
  draft: '要在对话里用：先发出第一句话',
  idle: '在这里用不了',
  busy: 'agent 正在回复：等这一轮结束（或先停止）再用',
}

/** 一条内置命令此刻为什么不能用；能用交回 null */
function blockedReason(spec: BuiltinSpec, context: CommandContext): string | null {
  if (spec.engine === true && findCommand(context.engine, spec.name) === null) return `/${spec.name} 现在不可用`
  if (!spec.places.includes(context.place)) return `/${spec.name} ${PLACE_REASON[context.place]}`
  return spec.blocked?.(context) ?? null
}

function builtinOf(spec: BuiltinSpec, context: CommandContext): AvailableCommand {
  const input = typeof spec.input === 'function' ? spec.input(context) : (spec.input ?? { kind: 'none' })
  return {
    name: spec.name,
    aliases: spec.aliases ?? [],
    description: spec.description,
    group: spec.group,
    input,
    effect: spec.effect,
  }
}

function contributedOf(item: SlashCommandContribution): AvailableCommand {
  return {
    name: item.name,
    aliases: item.aliases ?? [],
    description: item.description,
    group: 'settings',
    input: { kind: 'none' },
    effect: { kind: 'contributed', run: item.run },
  }
}

/* 内置命令与贡献的命令占掉的名字：用户写的同名命令不再列（omp 自己的路由也是内置优先） */
function takenNames(contributed: readonly SlashCommandContribution[]): ReadonlySet<string> {
  return new Set([
    ...BUILTINS.flatMap((spec) => [spec.name, ...(spec.aliases ?? [])]),
    ...contributed.flatMap((item) => [item.name, ...(item.aliases ?? [])]),
  ])
}

/**
 * 此刻面板该列的命令：内置清单里此刻能用的 + 贡献的 + 用户写的（omp 表里非内置来源）。按组序排，组内保持清单 / 表的次序。
 */
export function availableCommands(context: CommandContext): readonly AvailableCommand[] {
  const builtins = BUILTINS.filter((spec) => blockedReason(spec, context) === null).map((spec) =>
    builtinOf(spec, context),
  )
  const contributed = [...context.contributed].sort((a, b) => a.order - b.order).map(contributedOf)
  const taken = takenNames(context.contributed)
  const users = context.place === 'busy' ? [] : userCommands(context.engine, taken)
  const all = [...builtins, ...contributed, ...users]
  const order = (group: CommandGroupId): number => COMMAND_GROUPS.findIndex((entry) => entry.id === group)
  return all
    .map((command, at) => ({ at, command }))
    .sort((a, b) => order(a.command.group) - order(b.command.group) || a.at - b.at)
    .map((entry) => entry.command)
}

function userCommands(engine: readonly SlashCommand[], taken: ReadonlySet<string>): AvailableCommand[] {
  const out: AvailableCommand[] = []
  for (const command of engine) {
    if (command.source === 'builtin' || taken.has(command.name)) continue
    out.push({
      name: command.name,
      aliases: command.aliases,
      description: command.description ?? '',
      group: SOURCE_GROUP[command.source],
      input: userInput(command),
      effect: { kind: 'prompt' },
    })
  }
  return out
}

/**
 * 手打的一条命令落到哪儿：
 * - ready：此刻能用，照它执行；
 * - blocked：清单里有、此刻不能用 —— 横幅说为什么，草稿放回去；
 * - hidden：omp 有、GUI 不提供（`/ssh`、`/changelog`）—— 横幅说一句，不当一句话发给模型；
 * - null：不是命令（`/usr/bin` 这类随手的斜杠），照常当一句话发。
 */
export type CommandResolution =
  | { readonly kind: 'ready'; readonly command: AvailableCommand }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'hidden'; readonly name: string }

export function resolveCommand(name: string, context: CommandContext): CommandResolution | null {
  const available = findCommand(availableCommands(context), name)
  if (available !== null) return { kind: 'ready', command: available }
  const spec = SPEC_BY_NAME.get(name) ?? BUILTINS.find((entry) => entry.aliases?.includes(name))
  if (spec !== undefined) {
    return { kind: 'blocked', reason: blockedReason(spec, context) ?? `/${spec.name} 现在不可用` }
  }
  const engine = findCommand(context.engine, name)
  if (engine === null) return null
  /* 用户写的命令只在 agent 跑着时不收（引擎非空闲不收命令） */
  if (engine.source !== 'builtin') return { kind: 'blocked', reason: `/${engine.name} ${PLACE_REASON.busy}` }
  return { kind: 'hidden', name: engine.name }
}
