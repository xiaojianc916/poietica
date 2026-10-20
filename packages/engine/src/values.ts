import { invariant } from '@poietica/foundation'
import { z } from 'zod'

export const ModelRef = z.object({ provider: z.string().min(1), id: z.string().min(1) })
export type ModelRef = z.infer<typeof ModelRef>

/** 产品层的「权限档位」；engine-omp 映射到 omp 的 tools.approvalMode。 */
export const Posture = z.enum(['ask', 'auto-edit', 'full-access'])
export type Posture = z.infer<typeof Posture>

export const ThinkingLevel = z.string().min(1) // 取值由模型决定，来自 Controls.thinkingLevels
export const DeliverAs = z.enum(['turn', 'steer', 'followUp'])
export type DeliverAs = z.infer<typeof DeliverAs>

export const SessionState = z.enum(['idle', 'running', 'awaiting'])
export type SessionState = z.infer<typeof SessionState>

export const QueueItem = z.object({
  id: z.string(),
  text: z.string(),
  deliverAs: z.enum(['steer', 'followUp']),
  createdAt: z.number().int(),
  /** 调用方入队时给的号（`SubmitInput.ref`）原样回显：引擎不解释它，调用方靠它把队列项对回自己的记录（附件、提交行）。 */
  ref: z.string().optional(),
})
export const QueueSnapshot = z.object({
  items: z.array(QueueItem),
  modes: z.object({
    steer: z.enum(['all', 'one-at-a-time']),
    followUp: z.enum(['all', 'one-at-a-time']),
  }),
})
export type QueueSnapshot = z.infer<typeof QueueSnapshot>

/**
 * 上下文用量的**构成明细**（omp 自己的 `computeContextBreakdown`）。五类占用，五者之和即 usedTokens；
 * agent 没报就是 null，屏幕退成只画总条。omp 那份还带「空闲 / 自动压缩缓冲」两格，它们按定义就是窗口里剩下的灰条，
 * 屏幕不再单列（换成了会话用量那两行），端口也就不再转运。
 */
export const ContextUsageBreakdown = z.object({
  systemPrompt: z.number().int(),
  systemContext: z.number().int(),
  systemTools: z.number().int(),
  skills: z.number().int(),
  messages: z.number().int(),
})
export type ContextUsageBreakdown = z.infer<typeof ContextUsageBreakdown>

/**
 * 本会话**至今**的 token 用量：omp 的 `sessionManager.getUsageStatistics()` 原样转运（它的 `/usage` 命令、ACP 的
 * `usage_update` 读的同一份）。按会话文件里每条带用量的记录累计 —— 压缩不清零，已完成的子代理（task 结果）也在内。
 *
 * 口径照 omp（pi-ai 的 Usage）：`input` 是**未命中缓存**的输入，`cacheRead` / `cacheWrite` 各自另计，
 * `total = input + output + cacheRead + cacheWrite`。比率之类的派生数不在端口里算，屏幕按这几格现算。
 */
export const SessionTokenUsage = z.object({
  input: z.number().int(),
  output: z.number().int(),
  cacheRead: z.number().int(),
  cacheWrite: z.number().int(),
  total: z.number().int(),
})
export type SessionTokenUsage = z.infer<typeof SessionTokenUsage>

/**
 * 上下文用量：`usedTokens / windowTokens` 是读数，`breakdown` 是构成，`session` 是本会话至今的用量。
 * 窗口未知（模型没有窗口元数据）时整体报 null —— 没有分母就画不出圆环，报 0 只会画出一颗空的。
 * `session` 读不到（替身、老会话管理器）时是 null，屏幕不画那两行。
 */
export const ContextUsage = z.object({
  usedTokens: z.number().int(),
  windowTokens: z.number().int(),
  breakdown: ContextUsageBreakdown.nullable(),
  session: SessionTokenUsage.nullable(),
})
export type ContextUsage = z.infer<typeof ContextUsage>

/**
 * 会话此刻的目标快照（omp 的 `GoalModeState.goal` 折算；没有目标就是 null）。目标面板要画的不止正文：
 * 状态、秒针与 token 计数各有出处，只报一个字符串屏幕就只能凭空猜状态。
 * omp 的 `budget-limited` 折算成 `blocked`；`completionCriterion` / `turnsUsed` omp 里没有，恒报 null / 0，不编假值。
 */
export const SessionGoalSnapshot = z.object({
  objective: z.string(),
  completionCriterion: z.string().nullable(),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  turnsUsed: z.number().int(),
  tokensUsed: z.number().int(),
  wallClockMs: z.number(),
})
export type SessionGoalSnapshot = z.infer<typeof SessionGoalSnapshot>

export const Controls = z.object({
  model: z.object({
    current: ModelRef.nullable(),
    choices: z.array(z.object({ ref: ModelRef, label: z.string(), reasoning: z.boolean(), images: z.boolean() })),
  }),
  thinking: z.object({
    current: z.string().nullable(),
    choices: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
  posture: Posture,
  planMode: z.boolean(),
  /**
   * 目标正文：驱动输入框下方那颗「目标」开关（R-10）；没有目标、或目标已完成报 null。
   */
  goal: z.string().nullable(),
  /**
   * **可选**：老载荷（还没重新构建的 Core、测试夹具）不带这一格时按「没有目标」处置 ——
   * 不因缺字段把整张控件表判废，那会让输入框那一排选择器整排消失（真机故障）。
   */
  goalSnapshot: SessionGoalSnapshot.nullish(),
  /**
   * 这两档此刻能不能用（agent 设置里的 `plan.enabled` / `goal.enabled`，每次 `controls()` 现读）；不可用时 UI 隐藏对应选择器，
   * 引擎侧调用分别抛 `engine.plan_unavailable` / `engine.goal_unavailable`。
   * 例外（R-10）：清除目标与暂停目标不查这一格 —— 设置里关掉之后，挂着的目标仍要收得掉、停得下。
   */
  available: z.object({ plan: z.boolean(), goal: z.boolean() }),
  context: ContextUsage.nullable(),
})
export type Controls = z.infer<typeof Controls>

const InteractionBase = z.object({
  id: z.string(),
  createdAt: z.number().int(),
  timeoutAt: z.number().int().nullable(),
})
export const Interaction = z.discriminatedUnion('kind', [
  InteractionBase.extend({
    kind: z.literal('approval'),
    tool: z.string(),
    title: z.string(),
    detail: z.string(),
    allowSessionScope: z.boolean(),
  }),
  InteractionBase.extend({
    kind: z.literal('question'),
    questions: z.array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        multiple: z.boolean(),
        allowCustom: z.boolean(),
        options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().nullable() })),
      }),
    ),
  }),
  InteractionBase.extend({ kind: z.literal('select'), title: z.string(), options: z.array(z.string()) }),
  InteractionBase.extend({
    kind: z.literal('input'),
    title: z.string(),
    placeholder: z.string().nullable(),
    multiline: z.boolean(),
  }),
  InteractionBase.extend({ kind: z.literal('confirm'), title: z.string(), message: z.string() }),
  InteractionBase.extend({
    kind: z.literal('plan'),
    title: z.string(),
    /**
     * 计划文件的 `local://` 路径。人在批准前要能知道这篇计划落在哪 —— 卡片把它画在副行上，
     * 批准后它还会作为参考路径交回会话。
     */
    planFilePath: z.string(),
    planMarkdown: z.string(),
  }),
])
export type Interaction = z.infer<typeof Interaction>

export const InteractionAnswer = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    decision: z.enum(['approve', 'reject']),
    scope: z.enum(['once', 'session']),
    feedback: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('question'),
    answers: z.record(z.string(), z.object({ selected: z.array(z.string()), custom: z.string().nullable() })),
  }),
  z.object({ kind: z.literal('select'), value: z.string().nullable() }),
  z.object({ kind: z.literal('input'), value: z.string().nullable() }),
  z.object({ kind: z.literal('confirm'), value: z.boolean() }),
  z.object({
    kind: z.literal('plan'),
    decision: z.enum(['approve', 'reject', 'revise']),
    feedback: z.string().nullable(),
  }),
  z.object({ kind: z.literal('dismiss') }),
])
export type InteractionAnswer = z.infer<typeof InteractionAnswer>

export const UsageSample = z.object({
  provider: z.string(),
  model: z.string(),
  input: z.number().int(),
  output: z.number().int(),
  cacheRead: z.number().int(),
  cacheWrite: z.number().int(),
  cost: z.number(),
  at: z.number().int(),
})
export type UsageSample = z.infer<typeof UsageSample>

export const ProviderInfo = z.object({
  id: z.string(),
  name: z.string(),
  configured: z.boolean(),
  custom: z.boolean(),
  authKind: z.enum(['api_key', 'none']),
  docsUrl: z.string().nullable(),
})
/**
 * 一家可以用账号登录的服务商（omp 的 getOAuthProviders：Claude Pro/Max、ChatGPT/Codex、GitHub Copilot、Gemini CLI……）。
 * `provider` 是登录之后凭据记在哪一家名下（omp 的 storeCredentialsAs，没有就是 id）—— 它对得上 ProviderInfo.id 与模型的 provider。
 */
export const LoginProvider = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  /** omp 说这家此刻能不能走登录（缺依赖、平台不支持时为 false） */
  available: z.boolean(),
  /** 这家名下有账号登录留下的凭据（OAuth）。API Key、环境变量不算 —— 它们不是「登录」 */
  authenticated: z.boolean(),
  /** 登录的是哪个账号（omp 记下的邮箱或组织名）；没登录或 omp 没记时为 null */
  account: z.string().nullable(),
  /**
   * 这条登录走完拿回的是一把 API Key（OpenRouter、Devin 这类：浏览器里授权，换回一把钥匙存成 API Key），
   * 不是可刷新的账号凭据 —— 界面把它当「在浏览器中获取 API Key」，`authenticated` 恒为 false
   */
  issuesApiKey: z.boolean(),
})
/** 登录完成后 omp 报回的身份；`kind: 'api_key'` = 那一家的「登录」其实是收了一把钥匙 */
export const LoginIdentity = z.object({
  kind: z.enum(['oauth', 'api_key']),
  email: z.string().nullable(),
  orgName: z.string().nullable(),
})
/**
 * omp 的一个模型角色（`modelRoles.<role>`；内置 default/smol/slow/vision/plan/commit/tiny/memory/task/advisor 与
 * 模型种类区 image/web/speech/dictation/judge，外加用户在 omp 里自定义的角色）。`selector` 是 omp 原样的选择器
 * （`provider/id`、`provider/id:high`、`@smol` 都可能），null = 没配 → omp 按自己的回退链挑。
 */
export const ModelRoleInfo = z.object({
  role: z.string(),
  /** 角色名：内置角色给中文译名，用户在 omp modelTags 里改过名或自定义角色则原样交回 */
  name: z.string(),
  /** 这个角色在 omp 里管什么（内置角色才有） */
  description: z.string().nullable(),
  section: z.enum(['chat', 'kind']),
  selector: z.string().nullable(),
  /** 这一角色能选的模型（omp 的 roleCandidatePool：有凭据、过白名单、种类匹配） */
  candidates: z.array(z.object({ selector: z.string(), label: z.string() })),
  /**
   * 没配（selector 为 null）时 omp 实际怎么办：`role` = 跟着另一个角色走（如 tiny → smol）；`conversation` = 用当前对话
   * 的模型；`auto` = omp 按内置优先级自己挑，`model` 是它此刻挑中的那个的名字（挑不出为 null）。
   */
  fallback: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('role'), role: z.string() }),
    z.object({ kind: z.literal('conversation') }),
    z.object({ kind: z.literal('auto'), model: z.string().nullable() }),
  ]),
})
export const ModelInfo = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  contextWindow: z.number().int().nullable(),
  reasoning: z.boolean(),
  vision: z.boolean(),
})
/*
 * 一格设置的选项：`value` 是写回 agent 的标识符、**绝不参与翻译**，`label` 才是给人看的那一列。
 * 只报字符串数组会把中文选项名整层丢掉，界面只能把 `hindsight` 这种标识符直接上屏。
 */
export const SettingOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().nullable(),
})
export type SettingOption = z.infer<typeof SettingOption>

/** 归产品哪一个**剥离页**画；判据在 engine-omp 的 settings-catalog.ts（按 omp 自己的 tab 与 path 名单）。 */
export const SettingSection = z.enum(['memory', 'persona'])
export type SettingSection = z.infer<typeof SettingSection>

/*
 * 一格设置的描述符。只收引擎端口能如实回答的那些：
 *   - `group` 是 **omp 自己的分节键**，不是给人看的那一列 —— 界面按它建分组，换成中文会把两节合成一格且屏幕上看不出哪里错了；
 *   - `options` 的 `value` 是写回 agent 的标识，`label` 是给人看的；
 *   - `value` 在凭据类设置上恒为 null（值出了 agent 的进程就不再是我们的盘），配没配由 `hasValue` 说；
 *   - `owned` 说的是「这一行别处已经有控件」，与 `section` 正交：值照报，行不画；
 *   - `condition` 是判据的**名字**，求值在界面那一侧 —— 判据要用此刻的设置，而那正是界面上这份目录的 value。
 */
export const SettingDescriptor = z.object({
  path: z.string(),
  group: z.string(),
  groupLabel: z.string(),
  label: z.string(),
  description: z.string(),
  type: z.enum(['boolean', 'enum', 'number', 'string']),
  options: z.array(SettingOption).nullable(),
  value: z.unknown(),
  defaultValue: z.unknown(),
  /** 风险提示（会把用户拉进限流或封号的那类设置），原样上屏。 */
  warning: z.string().nullable(),
  condition: z.string().nullable(),
  owned: z.boolean(),
  section: SettingSection.nullable(),
  secret: z.boolean(),
  hasValue: z.boolean(),
})
export type SettingDescriptor = z.infer<typeof SettingDescriptor>
export const SkillInfo = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(['builtin', 'user', 'project']),
  enabled: z.boolean(),
  path: z.string(),
})
export const McpServerInfo = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
})
export const McpStatus = z.object({
  name: z.string(),
  state: z.enum(['connecting', 'connected', 'failed', 'disabled']),
  toolCount: z.number().int(),
  error: z.string().nullable(),
})
/**
 * 目录里的一条搜索结果（只读的展示件 + 可直接写进配置的正文）。
 *
 * `config` 是**已经能写盘的那一条**（omp 的 `MCPServerConfig`）：装上不等于能用，所以随条目一起把
 * 缺什么也带回来（`inputs` / `warnings`）。
 */
export const McpCatalogEntry = z.object({
  id: z.string(),
  /** 写进配置的**建议名**（已按 omp 的名称约束归一；重名由调用方另让用户改）。 */
  name: z.string(),
  title: z.string(),
  description: z.string(),
  /** 目录方给的地址；没有时 null。 */
  homepage: z.string().nullable(),
  /** 远端还是本地包，决定它跑起来要不要本机有 npx。 */
  sourceType: z.enum(['remote', 'package']),
  /** 用的人多不多（目录方的报数），列表按它排序。 */
  useCount: z.number().int(),
  verified: z.boolean(),
  /** 这一条要人补什么值才跑得起来。 */
  inputs: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      required: z.boolean(),
      /** 像个密钥（界面要遮住输入）。 */
      sensitive: z.boolean(),
      defaultValue: z.string().nullable(),
      description: z.string().nullable(),
    }),
  ),
  /** 目录方的提示（例如「运行时要经 Smithery CLI」）。 */
  warnings: z.array(z.string()),
  /** 直接可写进配置的正文。 */
  config: z.record(z.string(), z.unknown()),
})
export const PluginInfo = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  source: z.string(),
})
export const MarketplaceEntry = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  installed: z.boolean(),
})
/**
 * 一条斜杠命令（omp 的 `buildAvailableSlashCommands` 原样折算）。命令表与执行都归 omp：Poietica 只画、只转交，
 * 不维护自己的一份命令清单 —— 否则 omp 每加一条命令（或用户装一个带命令的插件），这里就落后一条。
 * `source` 只用于分组与图标；技能（`skill`）不进这张表，技能走输入框的技能标记那一条路，一个能力只有一个入口。
 */
export const SlashCommand = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()),
  description: z.string().nullable(),
  /** 参数提示（omp 的 inlineHint / acpInputHint）；null = 不带参数 */
  hint: z.string().nullable(),
  source: z.enum(['builtin', 'extension', 'custom', 'mcp_prompt', 'file']),
  subcommands: z.array(z.object({ name: z.string(), description: z.string().nullable() })),
})
export type SlashCommand = z.infer<typeof SlashCommand>

export const Capabilities = z.object({ computerUse: z.boolean(), browserControl: z.boolean() })

/**
 * 侧边提问（omp 的 `/btw`）一问一答的结局。`interrupted` = 上次进程还在答的时候退出了（omp 重开历史时把 running 改成它），
 * 与 `cancelled`（人按了停止）分开：屏幕对前者说「上次没答完」，对后者说「已停止」。
 */
export const SideTurnStatus = z.enum(['running', 'complete', 'cancelled', 'error', 'interrupted'])
export type SideTurnStatus = z.infer<typeof SideTurnStatus>

/** 侧边话题里的一问一答。`answer` 在 running 时是已经流出来的那一截；`error` 只在 status 为 error 时非空。 */
export const SideTurn = z.object({
  question: z.string(),
  answer: z.string(),
  status: SideTurnStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
  error: z.string().nullable(),
})
export type SideTurn = z.infer<typeof SideTurn>

/**
 * 一个侧边话题：第一问开题，之后的追问接在同一题下（omp 的 BtwHistoryRecord + followUps 摊平成一张表）。
 * `leafId` 是开题那一刻主对话停在哪一条（omp 的会话树叶子）；没有任何消息时是 null。
 * 话题存在会话的 artifacts 目录里，不进主会话文件：删对话一起删，分叉一起复制（refactor-log 记了这一条）。
 */
export const SideTopic = z.object({
  id: z.string().min(1),
  leafId: z.string().nullable(),
  turns: z.array(SideTurn).min(1),
})
export type SideTopic = z.infer<typeof SideTopic>

/** 话题里最后一问（正在答的、或者最近答完的那一问） */
export function latestSideTurn(topic: SideTopic): SideTurn {
  const turn = topic.turns.at(-1)
  /* schema 要求至少一问：走到这里说明有人绕过 schema 手搓了一个空话题 */
  invariant(turn !== undefined, `side topic ${topic.id} has no turns`)
  return turn
}
