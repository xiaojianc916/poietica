import type { ThreadId } from './address'
import type { SessionConfigControl } from './config'
import type { SessionUsage } from './usage'

/**
 * Where a conversation name came from.
 *
 * Three, and the platform can report no other: the name the user typed, one
 * taken from the opening message, and the placeholder shown before there was
 * anything to take a name from.
 *
 * A fourth used to sit above all of them — the title the agent wrote in its
 * own store when it created the session. It is written once and never
 * revised, so ranking it above what the user actually said is what turned
 * this list into a column of the words New Session. It is gone from the
 * platform, and the ranking below no longer mentions it.
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
   * 缺席有确定的含义 —— 默认那一个工作区。平台今天对每一条都报缺席（桌面侧
   * 建桥不传 cwd，IPC 送 cwd: cwd ?? null），所以存量对话本来就都在默认那一个
   * 里，读回来一行不差。这一格开始带上路径之后，界面不需要任何改动。
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

/** A conversation that was just opened, and what its session offers. */
export interface OpenedThread {
  readonly thread: ThreadRecord
  readonly selectors: readonly SessionConfigControl[]
  /**
   * 这条对话的经过，由本机的帧日志重放交回来。
   *
   * unknown 是故意的：帧的形状由平台那一侧定义，这里不重新定义它，也不在这
   * 一层校验 —— 与运行帧走同一条规矩。收窄只发生在转录 store 的入口一处。
   *
   * 空不代表什么都没发生过。空有五种由来，下面那一格说的就是哪一种。
   */
  readonly events: readonly unknown[]
  /**
   * 这段经过为什么是现在这个样子。
   *
   * events 为空时，它是唯一能说清缘由的东西。此前五种情况在这一层全部长得
   * 一模一样——一个空数组——于是界面除了画一片空白之外无话可说。
   */
  readonly history: ThreadHistory
  /**
   * 这条对话最近一次报过的上下文用量，本地账本记下的那份。
   *
   * 它是启动后的第一眼，不是活数据：Kimi 只在轮次落定后报一次，装载旧会话
   * 时不补报（协议建议补报，它没做），所以刚打开时实时通道上什么都没有。
   * 活报告一到即覆盖。缺席 = 从没报过。
   */
  readonly usage?: SessionUsage
}

/**
 * Conversations, as the interface needs them.
 *
 * Opening one is opening an agent session: the two are created together,
 * so a tab always stands for something the agent knows about.
 */
export interface ThreadPort {
  readonly list: () => Promise<readonly ThreadRecord[]>
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
  readonly open: (threadId?: ThreadId, workspaceRoot?: string | null) => Promise<OpenedThread>
  /** Renames one. The name becomes the user's and outlives the agent's. */
  readonly rename?: (threadId: ThreadId, title: string) => Promise<void>
  readonly remove?: (threadId: ThreadId) => Promise<void>

  /**
   * 从一条对话分叉出一条新对话（kap 的会话 fork 动作）。历史归 agent 所有，
   * 所以这是协议动作：agent 带着完整上下文开出新会话，本地只复制一行索
   * 引，源对话原样不动。交回新对话的记录 —— 打开它走 open 那条已有的路。
   *
   * title 是分叉出的对话叫什么，由调用方按命名规则算好（thread-title 的
   * forkNameOf）交进来，落库按用户起的名（manual）对待。
   */
  readonly fork?: (threadId: ThreadId, title: string) => Promise<ThreadRecord>
  /** Archives or restores a conversation without deleting its history. */
  readonly archive?: (threadId: ThreadId, archived: boolean) => Promise<void>
  readonly setPinned?: (threadId: ThreadId, pinned: boolean) => Promise<void>
}
