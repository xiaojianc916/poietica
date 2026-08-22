import type {
  ApprovalDecision,
  ApprovalScope,
  KapToolCallId,
  QuestionChoice,
  QuestionItem,
  QuestionOutcome,
  RunEvent,
  RunStatus,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from '@poietica/agent-contract'

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
 * 地址由原生侧拼好（`poietica-asset://asset/{thread}/{sha256}`），它随这一轮的
 * run_started 帧一起到达，所以这一侧不拼、也不必知道它属于第几句话。
 */
export interface MessageImage {
  readonly url: string
}

/**
 * 每一条转录条目共有的三个事实。
 *
 * turn 此前不在这里 —— 它只以字符串前缀的形式编在 id 里（r0-said-1），而没有
 * 任何一个地方解析它回来。于是「这一条属于第几轮」这个已经存在的事实读不出来，
 * 派生层只好反推：反向扫到最后一条 user_message，把它当作本轮的起点。同一个
 * 启发式在 feed-rows、timeline-queries、kap-projection 里各手抄了一遍。
 *
 * 而权威答案一直在状态里放着：runIndex。段由 run_started 划定，号由 openSegment
 * 发。把语义编进身份、再另起一套启发式去猜，本来就不是建模 —— 身份负责唯一，
 * 字段负责语义。补上这一格之后，那三处扫描的判据全部塌成一次相等比较。
 */
interface TimelineEntry {
  readonly id: TimelineItemId
  /**
   * 它属于第几段。
   *
   * 回放出来的段号是零或负数（最后一轮为 r0），实时开出来的为正。
   *
   * 人先说话时它与自己的答复同号：段在那一句话落账之前就开了（timeline-reducer
   * 的 appendUserMessage 先 openSegment 再 push）。只有一种情形它记的是上一段的
   * 号 —— 上一轮还在跑时插进来的那一句：那时不换段，因为换段会连 seq 窗口带 id
   * 前缀一起换掉，在飞的工具调用会认不回自己那张卡。
   */
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
  /** 这句话挂上的技能名，与图片同一条可选规矩。 */
  readonly skills?: readonly string[]
}

export interface AgentTextItem extends TimelineEntry {
  readonly type: 'agent_text'
  readonly text: string
  /**
   * 这些字属于哪一条消息，由 agent 自己说（delta 帧里的 messageId）。
   *
   * 与 sealed 是两件事，此前由 sealed 一个人兼着：sealed 说的是「还会不会再
   * 来字」，那是生命周期，喂的是流式动画；这里说的是「这些字属于谁」，那是
   * 身份，定的是边界。一个布尔同时表达两件事，边界就只能靠「末尾那条封没封
   * 口」去推 —— 背靠背发来的两条消息中间没有任何东西打断，于是被推成一条。
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

export interface ToolCallTimelineItem extends TimelineEntry {
  readonly type: 'tool_call'
  readonly toolCallId: KapToolCallId
  readonly title: string
  readonly kind: ToolKind
  /** 这次调用的主语：命令、路径、查询、地址、任务书。由 display 定。 */
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
   *
   * 唯一来源是 kap 的 display（kap-projection 的 fromDisplay）。
   */
  readonly requestContent: readonly ToolCallContent[]
  /** agent 交回来的那一份：进度与产出。 */
  readonly content: readonly ToolCallContent[]
  readonly locations: readonly ToolCallLocation[]
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

/** 这一帧是否开一个新段。段由它划定，所以判据只住在这里。 */
export function opensTurn(event: RunEvent): boolean {
  return event.kind === 'run_started'
}

/** 计划里的一步。 */
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
  readonly title: string
  readonly toolCall?: ToolCallUpdate
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
  | ErrorItem

/**
 * 一轮的两端。
 *
 * 起点是 run_started 那一帧的 at，终点在 run_finished / run_failed 落定时补上。有起点
 * 而缺终点，就是这一轮还在跑，所以不需要另一个布尔去说同一件事。
 *
 * 两端都取自日志里的 at（epoch 毫秒墙钟，原生侧 recorder.rs 的 now_millis 写下），
 * 不取本机时钟：同一份日志放两遍必须算出同一个耗时。performance.now() 的原点是每个
 * 进程各自的，与帧里的 at 不在同一条数轴上，所以它在这条链上不是一个可选项。
 *
 * 一条 span 首先是「这里有一轮」，其次才是「它花了多久」。段的存在由 turn 表达，耗时
 * 由两端表达，缺一端就是算不出 —— 算不出的耗时不显示，也绝不显示成 0s。
 */
export interface TurnSpan {
  readonly turn: number
  /**
   * 这一轮发出去的时刻。缺席表示这台机器没有记下它。
   *
   * 缺席只有一个来源：本机帧日志之前的旧对话 —— 那些帧没有落进 run_events，两端因此
   * 无从谈起。日志建立之后两端都在帧里，同一份日志放两遍算出同一个耗时。
   * 「不知道」与「一瞬间」是两件事，屏幕上不许把前者画成后者。
   */
  readonly startedAt?: number
  /** 有起点而缺终点，就是这一轮还在跑。 */
  readonly endedAt?: number
  /**
   * 这一轮收到第一帧 agent 内容的时刻 —— 思考、工具、计划、回复都算，报错与授权不算。
   *
   * startedAt 是 run_started 落账那一刻，它只证明请求出去了：一个额度耗尽的密钥、一个
   * 连不上的端点，同样会有起点。于是「正在处理」会抢在报错前面亮一下，而那时模型一帧
   * 都没回过。「模型已经在干活」因此是另一个事实，只能在这里记 —— 思考不上屏
   * （agent-ui 的 renderable），屏幕那一侧看不见它。
   *
   * 没收到过就没有这一格。重放走同一条管线，所以旧轮次同样有它 —— 只是它们都已落定，
   * 屏幕不再读这一格。
   */
  readonly firstFrameAt?: number
}

/**
 * The conversation, as the feed reads it.
 *
 * 它没有轮次号，因为它不是一轮：它是一条对话，由若干段组成。段号（runIndex）
 * 是从这段日志里数出来的，不是从外面交进来的 —— 它只用来给条目身份分命名
 * 空间，因为每一轮的帧都从一号开始编，光看 seq 分不出这是第几轮的第三帧。
 *
 * 此前这里还挂着一个 runId。它由 prompt 的答复事后补进来（transcript-store
 * 的 send），在那之前的值是字符串 'run_pending'，而从头到尾没有一个 selector
 * 或组件读过它。
 */
export interface TimelineState {
  readonly status: RunStatus
  readonly items: readonly TimelineItem[]
  /**
   * 这一段里已经收到的最大序号；零表示还没有收到任何一帧。
   *
   * 去重只需要它。序号由原生侧的 recorder 从一开始逐帧递增（recorder.rs 的
   * next_seq / saturating_add），帧走单条有序 IPC，并且在 RunSlot 的锁下顺序
   * 转发 —— 所以「到过」等价于「不大于它」。此前这里另挂一个 appliedSeqs 集合，
   * 每处理一帧整份复制一次，一轮 N 帧就是 O(N²)，而它能表达的东西并不比一个
   * 数字多。
   */
  readonly lastSeq: number
  readonly runIndex: number
  /**
   * 每一轮的两端，按轮次顺序。
   *
   * 与 items 分开，因为它答的是另一个问题：items 说这一轮里发生了什么，spans 说这
   * 一轮从什么时候到什么时候。把它算进条目会让「一轮的耗时」只存在于读模型里，而它
   * 由帧决定，本来就该跟着状态一起被持久化、被重放。
   */
  readonly spans: readonly TurnSpan[]
}
