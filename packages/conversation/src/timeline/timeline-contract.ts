import type {
  ApprovalDecision,
  ApprovalScope,
  KapToolCallId,
  QuestionChoice,
  QuestionItem,
  QuestionOutcome,
  RunEvent,
  RunStatus,
  SessionLink,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from '../agent'

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
 * prompt_admitted 帧一起到达，所以这一侧不拼、也不必知道它属于第几句话。
 */
export interface MessageImage {
  readonly url: string
}

/**
 * 每一条转录条目共有的三个事实。
 *
 * turn 是权威的归属，不从 id 前缀里解析回来：身份负责唯一，字段负责语义。
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
   * 通用展示字段来自 kap display；Kimi TodoList 的清单正文只由 kimi-todo 从已校验入参投影。
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

/** 这一帧是否开一个新段。段由它划定，所以判据只住在这里。 */
export function opensTurn(event: RunEvent): boolean {
  return event.kind === 'prompt_admitted'
}

/** 这一帧是否收掉这一轮。与 opensTurn 成对：帧的形状只在这个包里认。 */
export function endsRun(event: RunEvent): boolean {
  return event.kind === 'run_finished' || event.kind === 'run_failed'
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

/**
 * 这一轮还接得住新指令：插话与取消都算。
 *
 * 比 isInFlight 少一档 cancelling —— 取消已经在路上，再取消一次没有第二个效果，
 * 而那一刻插进来的话属于正在收尾的这一轮。这一档差别此前没有名字，于是同一个
 * 集合在三处各抄一遍，抄漏一项不会有任何东西报警。
 */
export function isSteerable(status: RunStatus): boolean {
  return isInFlight(status) && status !== 'cancelling'
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
  /** 要批准的那件事：由请求自带的 display 投出（kap-projection 的 requestedCall）。 */
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
  | ErrorItem

/**
 * 一轮的两端。
 *
 * 起点是 prompt_admitted 那一帧的 at，终点在 run_finished / run_failed 落定时补上。有起点
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
   * 这一轮最后一帧的时刻。
   *
   * 运行中的耗时以它为终点，两端因此同在日志域，秒表也不会超过实际收帧的跨度。
   */
  readonly lastFrameAt?: number
}

/**
 * 一段轮次的条目，按到达顺序。
 *
 * 封口之后不再改写，跨帧按引用共享 —— 派生因此只重算活动的那一段。唯一的例外是
 * 下一轮认领它尾部那条排队提问（timeline-draft 的 takeQueued）：那一条本来就属于
 * 下一段。
 */
export interface TurnPage {
  readonly turn: number
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
