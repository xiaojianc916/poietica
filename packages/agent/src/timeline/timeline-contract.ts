import type {
  AcpPermissionOption,
  AcpPlanEntry,
  AcpToolCallContent,
  AcpToolCallId,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpToolCallUpdate,
  AcpToolKind,
  RunStatus,
} from '@poietica/agent-contract'

/**
 * The timeline projection.
 *
 * One flat, ordered list of typed entries. A tool call is a first-class entry
 * with its own identity and lifecycle, not a part buried inside a message:
 * tool_call_update addresses it by id, so it must be addressable by id here too.
 */

export type TimelineItemId = string

/**
 * 一张随这句话发出去的图片，已经可以直接画。
 *
 * 存的是能进 \`<img src>\` 的东西，不是字节：条目是给读模型看的，而读模型只想
 * 知道往哪儿指。地址由原生侧交回，实时与重放两条路拿到的是同一条。
 *
 * 历史里这一格不再是空的。日志里确实没有图片帧 —— 图不来自 agent，它是这台
 * 机器上的文件，由本地账本按「第几句话、第几张」挂回来（重放走 attachImages，
 * 刚发出去的那一句走 attachImagesTo）。
 * URL 的形状是协议的事，由原生侧拼好交出来，这一层不认识 scheme，也不拼。
 */
export interface MessageImage {
  /** 一条资产协议地址，由原生侧按平台拼好，这一层不认识它的 scheme。 */
  readonly url: string
}

/**
 * 每一条转录条目共有的三个事实。
 *
 * turn 此前不在这里 —— 它只以字符串前缀的形式编在 id 里（r0-said-1），而没有
 * 任何一个地方解析它回来。于是「这一条属于第几轮」这个已经存在的事实读不出来，
 * 派生层只好反推：反向扫到最后一条 user_message，把它当作本轮的起点。同一个
 * 启发式在 feed-rows、timeline-queries、acp-projection 里各手抄了一遍。
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
}

export interface AgentTextItem extends TimelineEntry {
  readonly type: 'agent_text'
  readonly text: string
  /**
   * 这些字属于哪一条消息，由 agent 自己说（ContentChunk.messageId）。
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
  readonly toolCallId: AcpToolCallId
  readonly title: string
  readonly kind: AcpToolKind
  readonly status: AcpToolCallStatus
  readonly content: readonly AcpToolCallContent[]
  readonly locations: readonly AcpToolCallLocation[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly startedAt: number
  readonly endedAt?: number
}

export interface PlanItem extends TimelineEntry {
  readonly type: 'plan'
  readonly entries: readonly AcpPlanEntry[]
}

export interface PermissionItem extends TimelineEntry {
  readonly type: 'permission'
  readonly requestId: string
  readonly title: string
  readonly toolCall?: AcpToolCallUpdate
  readonly options: readonly AcpPermissionOption[]
  readonly resolution?: { readonly optionId: string; readonly outcome: 'selected' | 'cancelled' }
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
   * 缺席只有一个来源：重放回来的历史。协议不给重放的帧带回原来的时刻，所以那些轮次的
   * 两端只能由本机账本回答（turn-spans 的 restampTurns），账本没盖住的就是不知道。
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
   * 没收到过就没有这一格。回放出来的轮次也没有：它们都已经落定，用不着这个事实。
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
