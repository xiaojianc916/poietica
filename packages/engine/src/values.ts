import { z } from 'zod'

export const ModelRef = z.object({ provider: z.string().min(1), id: z.string().min(1) })
export type ModelRef = z.infer<typeof ModelRef>

/** 姿态：产品层的“权限档位”。engine-omp 映射到 omp 的 tools.approvalMode。 */
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
 * 上下文用量的**构成明细**（omp 自己的 `computeContextBreakdown`，/context 面板那一份）。
 *
 * 七格 = 五类占用（五者之和即 usedTokens）+ 空闲 + 自动压缩缓冲。面板上的行与条上的
 * 分段都按它画；agent 没报就是 null，屏幕退成只画总条。
 */
export const ContextUsageBreakdown = z.object({
  systemPrompt: z.number().int(),
  systemContext: z.number().int(),
  systemTools: z.number().int(),
  skills: z.number().int(),
  messages: z.number().int(),
  free: z.number().int(),
  autoCompactBuffer: z.number().int(),
})
export type ContextUsageBreakdown = z.infer<typeof ContextUsageBreakdown>

/**
 * 上下文用量：`usedTokens / windowTokens` 是读数（输入框那颗圆环与面板的表头），
 * `breakdown` 是构成（点开的面板）。窗口未知（模型没有窗口元数据）时引擎侧一律报
 * null —— 没有分母就画不出圆环，报 0 只会画出一颗空的。
 */
export const ContextUsage = z.object({
  usedTokens: z.number().int(),
  windowTokens: z.number().int(),
  breakdown: ContextUsageBreakdown.nullable(),
})
export type ContextUsage = z.infer<typeof ContextUsage>

/**
 * 会话此刻的目标快照（omp 的 `GoalModeState.goal` 折算；没有目标就是 null）。
 *
 * 目标面板要画的不止正文：状态决定写「进行中的目标 / 已暂停的目标 / 受阻的目标」，
 * 秒针与 token 计数各有出处。只报一个字符串，屏幕就只能凭空猜状态 —— 故整份报。
 * omp 的 `budget-limited` 折算成 `blocked`（与 legacy goalSnapshotOf 同一条），
 * `dropped` 在适配器那一层折成 null。`completionCriterion` / `turnsUsed` omp 里没有，
 * 恒报 null / 0，不编假值。
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
   * 目标正文：进行中 / 已暂停 / 受阻的目标报正文；没有目标、或目标已完成报 null（R-10：
   * 它驱动输入框下方那颗「目标」开关，完成之后开关要能重新打开）。完成那一档由 goalSnapshot 如实报。
   */
  goal: z.string().nullable(),
  /**
   * 目标面板要画的那一份（状态 / 用量 / 秒针）；没有目标是 null。
   *
   * **可选**：老载荷（还没重新构建的 Core、测试夹具）不带这一格时按「没有目标」处置，
   * 不因缺字段把整张控件表判废 —— 那会让输入框那一排选择器整排消失（真机故障）。
   */
  goalSnapshot: SessionGoalSnapshot.nullish(),
  /**
   * 这两档此刻能不能用（agent 设置里的 `plan.enabled` / `goal.enabled`，每次 `controls()` 现读）。
   *
   * 不可用时 UI 隐藏对应选择器；引擎侧调用分别抛 `engine.plan_unavailable` /
   * `engine.goal_unavailable`（04 页 §3.10 附近的口径：不可见的东西也点不动）。
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
     * 计划文件的 `local://` 路径（04 页 §3.12）。人在批准前要能知道这篇计划落在哪 ——
     * 卡片把它画在副行上（legacy 也是这么做的），批准后它还会作为参考路径交回会话。
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
 * 一格设置的选项：取值与说法**同一件事**。
 *
 * legacy 的 AgentSettingEntry.options 就是这三格（value / label / description），
 * 而 `value` 是写回 agent 的标识符、**绝不参与翻译**：label 才是给人看的那一列。
 * 只报字符串数组（旧形状）会把中文选项名整层丢掉，界面只能把 `hindsight` 这种
 * 标识符直接上屏 —— 而 omp 自己那份面板画的是「Hindsight」。
 */
export const SettingOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().nullable(),
})
export type SettingOption = z.infer<typeof SettingOption>

/**
 * 归产品哪一个**剥离页**画。
 *
 * `memory` 与 `persona`（个性化）本来混在 agent 自己的栏目里，产品各拆成一页；
 * 判据在适配器侧（engine-omp 的 settings-catalog.ts，按 omp 自己的 tab 与 path 名单）。
 */
export const SettingSection = z.enum(['memory', 'persona'])
export type SettingSection = z.infer<typeof SettingSection>

/*
 * 一格设置的描述符。字段与 legacy 的 AgentSettingEntry 对齐，只收引擎端口能如实回答的那些：
 *
 *   - `group` 是 **omp 自己的分节键**（`Prompt` / `Mnemopi`…），不是给人看的那一列 ——
 *     界面按它建分组，换成中文会把两节合成一格且屏幕上看不出哪里错了；
 *   - `groupLabel` 才是给人看的那一列（译不到就与 `group` 同值）；
 *   - `options` 的 `value` 是写回 agent 的标识，`label` 是给人看的；
 *   - `value` 在凭据类设置上恒为 null（值出了 agent 的进程就不再是我们的盘），
 *     配没配由 `hasValue` 说；
 *   - `owned` 说的是「这一行别处已经有控件」，与 `section` 正交：值照报，行不画；
 *   - `condition` 是判据的**名字**（`mnemopiActive`…），求值在界面那一侧 ——
 *     判据要用此刻的设置，而那正是界面上这份目录的 value。
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
  /** 风险提示（会把用户拉进限流或封号的那类设置），原样上屏 */
  warning: z.string().nullable(),
  /** 可见性条件的名字，不是判据 */
  condition: z.string().nullable(),
  /** 这一格的行由产品别处的控件负责：值照报，行不画 */
  owned: z.boolean(),
  /** 归产品哪一个剥离页画；null 即不属于任何一页 */
  section: SettingSection.nullable(),
  /** 凭据格：value 恒为 null，只报有没有配 */
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
export const Capabilities = z.object({ computerUse: z.boolean(), browserControl: z.boolean() })
