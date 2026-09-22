import type { KapToolCallId } from '../agent/kap'
import type { SessionLink } from '../agent/link'
import type { ApprovalDecision, ApprovalScope } from '../agent/permission'
import type { QuestionChoice, QuestionItem } from '../agent/question'
import type { QuestionOutcome, RunStatus } from '../agent/run'
import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from '../agent/tool-call'

/**
 * The timeline projection.
 *
 * One flat, ordered list of typed entries. A tool call is a first-class entry
 * with its own identity and lifecycle, not a part buried inside a message:
 * kap 按 toolCallId 寻址它的四个生命周期事件（tool.call.delta、tool.call.started、
 * tool.progress、tool.result），所以这里也必须按 id 寻址。
 */

export type TimelineItemId = string

/**
 * 一张挂在某条用户消息上的图片。
 *
 * 历史图片的字节在 agent 的 media 端点后（要 Bearer），webview 不能直连：原生侧
 * 代取回来之前这一格先画占位（pending），解析完换成 url。
 */
export interface MessageImage {
  /** 已解析的资产/data 地址；pending 时整格缺席。 */
  readonly url?: string
  /** 字节还在原生侧代取，先画占位；取失败也停在占位，不挡对话。 */
  readonly pending?: boolean
}

/** 一张挂在用户消息上的通用文件卡片：没有预览，只有名字与「类型 大小」。 */
export interface MessageFile {
  readonly name: string
  /** 文件卡片第二行，投影层拼好的「TXT 22.89KB」。 */
  readonly meta: string
}

/** 扩展名是人认得的那个词：去点、大写、截短；没有扩展名给「文件」。 */
export function fileExtensionLabel(name: string): string {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  return extension === '' ? '文件' : extension.slice(0, 5).toUpperCase()
}

/** 人读的字节数：22.89KB、1.2MB；给不出大小返回 undefined。 */
export function formatByteSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return undefined
  }
  if (bytes < 1024) {
    return `${String(bytes)}B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  const shown =
    value >= 100 || Number.isInteger(value)
      ? String(Math.round(value))
      : value.toFixed(2).replace(/\.?0+$/, '')
  /* 四舍五入能把 1023.99 推成 1024：那不是「1024 千字节」，是下一个单位。 */
  if (Number(shown) >= 1024 && unit < units.length - 1) {
    return `1${units[unit + 1]}`
  }
  return `${shown}${units[unit]}`
}

/** 文件卡片那一行：「TXT 22.89KB」；没有大小就只剩类型词。 */
export function fileMetaLabel(name: string, size: number | undefined): string {
  const kind = fileExtensionLabel(name)
  const bytes = formatByteSize(size)
  return bytes === undefined ? kind : `${kind} ${bytes}`
}

/**
 * 每一条转录条目共有的三个事实。
 *
 * turn 是权威的归属，不从 id 前缀里解析回来：身份负责唯一，字段负责语义。
 */
interface TimelineEntry {
  readonly id: TimelineItemId
  /** 官方运行的序号，不由用户气泡推断。 */
  readonly turn: number
  readonly at: number
}

export interface UserMessageItem extends TimelineEntry {
  readonly type: 'user_message'
  readonly text: string
  /**
   * 这句话带的图片。
   *
   * 可选，而且是「整个键不写」而不是「值为 undefined」—— exactOptionalPropertyTypes
   * 下两者不是一回事，而重放出来的条目本来就没有这一格。
   */
  readonly images?: readonly MessageImage[]
  /** 这句话带的通用文件卡片，与图片同一条可选规矩。 */
  readonly files?: readonly MessageFile[]
  /** 这句话挂上的技能名，与图片同一条可选规矩。 */
  readonly skills?: readonly string[]
}

export interface AgentTextItem extends TimelineEntry {
  readonly type: 'agent_text'
  readonly text: string
  /**
   * 这些字属于哪一条消息，由 agent 自己说（delta 帧里的 messageId）。
   *
   * 与 sealed 是两件事：sealed 说的是「还会不会再来字」，那是生命周期；这里说的是
   * 「这些字属于谁」，那是身份，定的是边界。
   *
   * 缺席表示这个 agent 不报身份，边界退回相邻推断。
   */
  readonly messageId?: string
  /** Sealed entries never receive further chunks. 只管生命周期。 */
  readonly sealed: boolean
}

export interface AgentThoughtItem extends TimelineEntry {
  readonly type: 'agent_thought'
  readonly text: string
  readonly messageId?: string
  readonly sealed: boolean
}

/** 这次派发开出的一条通道：号与名字由 kap 的 subagent.spawned 给。 */
export interface DelegateChannel {
  readonly agentId: string
  readonly name: string
}

export interface ToolCallTimelineItem extends TimelineEntry {
  readonly type: 'tool_call'
  readonly toolCallId: KapToolCallId
  readonly title: string
  readonly kind: ToolKind
  /** 调用主语由工具身份、结构化入参与展示信息单向投影。 */
  readonly subject: string
  /** 后台派发：它不占这一轮的前台。 */
  readonly isBackground?: true
  readonly status: ToolCallStatus
  /**
   * 我们送出去的那一份：要执行的命令、要写进去的正文、要照着做的清单。
   *
   * 与 content 分开，因为它们是两个面。此前一次写入的 diff 也落在 content 里，而
   * 抽屉把整格 content 归给「交回来的那一面」—— 入参被画成了产出。两个面各有一格,
   * 就没有哪一格需要靠来源去猜它该画在哪边。
   */
  readonly requestContent: readonly ToolCallContent[]
  /** agent 交回来的那一份：进度与产出。 */
  readonly content: readonly ToolCallContent[]
  readonly locations: readonly ToolCallLocation[]
  /** 这次调用开出的子代理通道，按 spawn 顺序。空表示它不是一次派发。 */
  readonly channels: readonly DelegateChannel[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly startedAt: number
  readonly endedAt?: number
}

/**
 * 这次调用已经有结局了吗。
 *
 * 四档 status 里只有 completed 与 failed 是终态。endedAt 记不记、纺锤转不转，
 * 读的必须是同一份判据，所以它和状态词汇住在一起。
 */
export function isTerminal(status: ToolCallTimelineItem['status']): boolean {
  return status === 'completed' || status === 'failed'
}

/** 这一轮还没落定：还会来帧，屏幕上还该转。 */
export function isInFlight(status: RunStatus): boolean {
  return (
    status === 'submitted' ||
    status === 'running' ||
    status === 'cancelling' ||
    status === 'awaiting_permission' ||
    status === 'awaiting_question'
  )
}

/** 计划里的一步。 */
export type TodoStatus = 'pending' | 'in_progress' | 'done'

export interface TodoItem {
  readonly title: string
  readonly status: TodoStatus
}

export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost'

export interface BackgroundTaskItem {
  readonly taskId: string
  readonly description: string
  readonly status: BackgroundTaskStatus
}

export interface PlanStep {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/**
 * agent 此刻照着做的那份计划。
 *
 * 这一格此前直接装协议的 PlanEntry，于是产品模型里多了一句协议方言：另一条线要落
 * 一份计划，就得先替协议编一个自己根本不报的 priority。而屏幕只读两格 —— 画计划的
 * 那一格读 content 与 status，上屏判据读长度，协议的第三样东西没有读者。
 *
 * 所以这里存屏幕真的读的那两格，方言各自往上映。三档状态的名字两条线逐字相同，
 * 映射因此是一次挑字段，不是一张要跟着协议走的翻译表。
 */
export interface PlanItem extends TimelineEntry {
  readonly type: 'plan'
  readonly entries: readonly PlanStep[]
}

export interface PermissionItem extends TimelineEntry {
  readonly type: 'permission'
  readonly requestId: string
  /** 工具名。要批准的那件事说不出来时的最后一层退路。 */
  readonly title: string
  /** 要批准的那件事：由请求自带的 display 投出。 */
  readonly kind: ToolKind
  readonly subject: string
  readonly locations: readonly ToolCallLocation[]
  /** 缺席表示还在等人答；在场时就是 kap 记下的那个答复。 */
  readonly resolution?: {
    readonly decision: ApprovalDecision
    readonly scope?: ApprovalScope
  }
}

/**
 * 一组待答的题。
 *
 * 它是协议自己的通道（kap 的 questions），不借权限请求：题面、选项、多选与自选
 * 都由 QuestionItem 自己带。resolution 缺席表示还在等答；
 * 在场时 outcome 说怎么结的，answers 逐题记下答复，note 是整组的备注。
 */
export interface QuestionTimelineItem extends TimelineEntry {
  readonly type: 'question'
  readonly questionId: string
  readonly toolCallId?: string
  readonly questions: readonly QuestionItem[]
  readonly resolution?: {
    readonly outcome: QuestionOutcome
    readonly answers: Readonly<Record<string, QuestionChoice>>
    readonly note: string
  }
}

/**
 * 这条连接在这一轮里的处境。
 *
 * 形状的正本是帧的载荷（crates/kap-client/src/link.rs 的 LinkState），所以这
 * 一格原样存它：一次断线因此与它耽误的那一轮同生共死，重开对话是重放它。
 */
export interface LinkTimelineItem extends TimelineEntry {
  readonly type: 'link'
  readonly link: SessionLink
}

/**
 * kap 收下了、还没落定的那一句的号。
 *
 * 只有号：正文与顺序归 interjection 出账簿，那一句也已经作为用户消息落过一次。
 * 这一格的唯一用途是给 steer 提供寻址 —— 号由协议签发，本机认不出来。
 */
export interface InflightPromptItem extends TimelineEntry {
  readonly type: 'inflight_prompt'
  readonly promptId: string
  readonly settled?: true
}

export type CompactionState = 'running' | 'blocked' | 'cancelled' | 'completed'

export interface CompactionTimelineItem extends TimelineEntry {
  readonly type: 'compaction'
  readonly agentId: string
  readonly state: CompactionState
  readonly trigger?: 'manual' | 'auto'
  readonly instruction?: string
  readonly turnId?: number
  readonly tokensBefore?: number
  readonly tokensAfter?: number
}

export interface ErrorItem extends TimelineEntry {
  readonly type: 'error'
  readonly message: string
}

export type TimelineItem =
  | UserMessageItem
  | AgentTextItem
  | AgentThoughtItem
  | ToolCallTimelineItem
  | PlanItem
  | PermissionItem
  | QuestionTimelineItem
  | LinkTimelineItem
  | InflightPromptItem
  | CompactionTimelineItem
  | ErrorItem

/**
 * 一轮的时间事实。终态耗时以 transcript 的 durationMs 为准；时间戳只负责
 * 运行态推进。缺席表示上游没有提供，不反推、不伪造。
 */
export interface TurnSpan {
  readonly turn: number
  readonly durationMs?: number
  readonly startedAt?: number
  readonly endedAt?: number
  readonly lastFrameAt?: number
}

/**
 * 一段轮次的条目，按到达顺序。
 *
 * 封口之后不再改写，跨帧按引用共享 —— 派生因此只重算活动的那一段。
 */
export interface TurnPage {
  readonly turn: number
  /** 缺席表示尚无官方运行事实，不能从消息反推。 */
  readonly run?: {
    readonly settled: boolean
    readonly undoCount: number | null
    readonly forkUnavailableReason: string | null
  }
  readonly items: readonly TimelineItem[]
}

/**
 * 一条对话。
 *
 * 段号（active.turn）只给条目身份分命名空间：每一轮的帧都从一号开始编，光看 seq
 * 分不出这是第几轮的第三帧。
 */
export interface TimelineState {
  readonly status: RunStatus
  readonly backgroundTasks: readonly BackgroundTaskItem[]
  /** 已封口的段，按轮次顺序。 */
  readonly sealed: readonly TurnPage[]
  /** 正在写的那一段：写入只发生在这里，复制的代价因此只与它的长度相关。 */
  readonly active: TurnPage
  /**
   * 这一段里已经收到的最大序号；零表示还没有收到任何一帧。
   *
   * 去重只需要它：序号由 recorder.rs 逐帧递增，帧走单条有序 IPC，所以「到过」等价于
   * 「不大于它」。
   */
  readonly lastSeq: number
  /**
   * 每一轮的两端，按轮次顺序。
   *
   * 与条目分开，因为它答的是另一个问题：段说这一轮里发生了什么，span 说它从什么时候
   * 到什么时候。
   */
  readonly spans: readonly TurnSpan[]
}

/**
 * 全部条目按序摊平：封口段在前，活动段在后。
 *
 * 热路径不走它 —— 摊平正是分段要省掉的那次复制；它给测试与诊断读全量用，
 * 也是「按序遍历每一条条目」的唯一产地。
 */
export function allItems(state: TimelineState): readonly TimelineItem[] {
  return [...state.sealed.flatMap((page) => page.items), ...state.active.items]
}
