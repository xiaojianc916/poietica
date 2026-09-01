import type { ThreadId } from './address'
import type { SessionConfigControl } from './config'
import type { SessionGoal } from './goal'
import type { RunEvent } from './run'
import type { SessionUsage } from './usage'

/**
 * Where a conversation name came from.
 *
 * Three, and the platform can report no other: the name the user typed, one
 * taken from the opening message, and the placeholder shown before there was
 * anything to take a name from.
 */
export type ThreadTitleSource = 'manual' | 'message' | 'fallback'

/** One conversation, as the platform reports it. */
export interface ThreadRecord {
  readonly threadId: ThreadId
  /** The agent session it is holding, where it holds one. */
  readonly sessionId: string | null
  readonly title: string
  readonly titleSource: ThreadTitleSource
  readonly updatedAt: string
  /** Whether it is held at the top of the list. */
  readonly pinned?: boolean
  /**
   * 它是在哪个工作目录里开的。
   *
   * 列表的一级索引就是它：对着一个工作目录干活的客户端，主线索是「在哪个项目
   * 里」，不是「什么时候说的」。
   *
   * 缺席有确定的含义 —— 默认那一个工作区。平台今天对每一条都报缺席，所以存量
   * 对话本来就都在默认那一个里，读回来一行不差。这一格开始带上路径之后，界面
   * 不需要任何改动。
   */
  readonly workspaceRoot?: string | null
  /** Whether the conversation is outside the active list. */
  readonly archived?: boolean
}

/**
 * 一段经过要不回来时，是哪一种要不回来。
 *
 * 两种，原生侧报不出第三种：这条对话的会话在别的 agent 手里，或者 agent 那侧
 * 已经不认得这个会话号了。
 */
export type ThreadHistoryLoss = 'otherAgent' | 'forgotten'

/**
 * 打开一条对话之后，它的经过处在什么状态。
 *
 * 判别联合，不是一个可空的字符串：坏消息带着理由和持有者，好消息什么都不带，
 * 于是「有理由却是好消息」这种状态在类型里无法被写出来。
 *
 * fresh 是刚建的一条，live 是会话一直没离开过本次连接（屏幕上的东西本来就还
 * 在），loaded 是刚从 agent 那侧装载回来。这三种的空是真的空。
 */
export type ThreadHistory =
  | { readonly state: 'fresh' }
  | { readonly state: 'live' }
  | { readonly state: 'loaded' }
  | {
      readonly state: 'unavailable'
      readonly reason: ThreadHistoryLoss
      /** 那条会话在谁手里，报得出来的时候。 */
      readonly owner: string | null
    }

/** 一页帧从哪儿往前读。平台发的位置，原样回传。 */
export interface FrameCursor {
  readonly sessionId: string
  readonly seq: number
}

/** 一页帧，以及更早那一页从哪儿接着读；`before` 为 null 就是前面没有了。 */
export interface FramePage {
  /**
   * 这一页的帧，按追加顺序。
   *
   * 帧的形状由 frame.rs 定义；从线上原文收窄成运行帧发生在桥
   * （native-bridge 的 gateways/agent.ts），到这一层已经是端口词汇。
   */
  readonly events: readonly RunEvent[]
  readonly before: FrameCursor | null
}

/**
 * 目录里的一轮：地址、问的头一句、答的头几行。
 *
 * 字数由平台按预览卡看得见的行数截断，所以这一层不再截第二遍。
 */
export interface TurnMark {
  /** 这一轮第一帧在库上的位置。跳转与续读都认它。 */
  readonly at: FrameCursor
  /** 屏幕上那条用户消息的身份，与这一格逐字相同。 */
  readonly admissionId: string
  readonly prompt: string
  readonly reply: string | null
}

/** A local, bounded read-model snapshot. Reading it never starts an agent. */
export interface ThreadSnapshot {
  readonly thread: ThreadRecord
  readonly frames: FramePage
  readonly usage?: SessionUsage
}

/** A conversation that was just opened, and what its session offers. */
export interface OpenedThread {
  readonly thread: ThreadRecord
  readonly selectors: readonly SessionConfigControl[]
  readonly goal: SessionGoal | null
  readonly history: ThreadHistory
}

/**
 * Conversations, as the interface needs them.
 *
 * Opening one is opening an agent session: the two are created together,
 * so a tab always stands for something the agent knows about.
 */
export interface ThreadPort {
  readonly list: () => Promise<readonly ThreadRecord[]>
  /** Reads the bounded local transcript snapshot without activating an agent. */
  readonly read: (threadId: ThreadId) => Promise<ThreadSnapshot>
  /**
   * 打开一条对话：不点名就新开一条，点名就让那一条握住一个会话。
   *
   * 点开一条上次运行留下的对话也走这里。它存着的会话号在新的 agent 进程里不是
   * 活的，但那条会话仍在 agent 那侧：原生侧因此走 kap 的会话 load 动作把它装载
   * 回来，号不变，上下文因此还在。此前这里写的是"开一个新的并改写持有关系" ——
   * 那不是设计，那是一个把上下文丢掉、并且顺手覆盖掉旧号的 bug。
   *
   * 只有装载不回来（号在 server 侧也没了）才真的新开一条。三条路都在同一次
   * 答复里带回整张选择器表。
   */
  readonly create: (threadId: ThreadId, workspaceRoot?: string | null) => Promise<OpenedThread>
  readonly open: (threadId: ThreadId) => Promise<OpenedThread>
  /**
   * 这条对话更早的一页经过，从 `before` 那一帧往前数。
   *
   * 位置原样回传，这一层不解释它：它是平台那侧库上的键。轮次的对齐归转录
   * store。平台交回的每页都从 prompt_admitted 开始，连续文本 delta 已压成 block。
   */
  readonly earlierFrames: (threadId: ThreadId, before: FrameCursor) => Promise<FramePage>
  /**
   * 这条对话的整本目录，一轮一行。
   *
   * 定义域是平台的帧日志，不是界面此刻载入了多少：目录的长度因此不随滚动伸缩。
   */
  readonly outline: (threadId: ThreadId) => Promise<readonly TurnMark[]>
  /** 目录点名的那一轮到 `before` 之间的缺口，一次读回来。 */
  readonly framesUntil: (
    threadId: ThreadId,
    from: FrameCursor,
    before: FrameCursor,
  ) => Promise<FramePage>
  /** Renames one. The name becomes the user's and outlives the agent's. */
  readonly rename?: (threadId: ThreadId, title: string) => Promise<void>
  readonly remove?: (threadId: ThreadId) => Promise<void>

  /**
   * 从某一轮分叉出一条新对话。历史归 agent 所有，所以这是协议动作：agent
   * 复制上下文再回退到分叉点，本机日志按同一个数截断，源对话原样不动。
   * 交回新对话的记录 —— 打开它走 open 那条已有的路。
   *
   * title 由调用方按命名规则算好（thread-title 的 forkNameOf）交进来，落库
   * 按用户起的名（manual）对待。dropTurns 是分叉点之后还有几轮，0 是最后一轮。
   */
  readonly fork?: (threadId: ThreadId, title: string, dropTurns: number) => Promise<ThreadRecord>
  /** Archives or restores a conversation without deleting its history. */
  readonly archive?: (threadId: ThreadId, archived: boolean) => Promise<void>
  readonly setPinned?: (threadId: ThreadId, pinned: boolean) => Promise<void>
}
