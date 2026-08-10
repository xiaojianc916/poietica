import type { ThreadId } from './address'
import type { SessionConfigControl } from './config'

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
 * 三种，原生侧报不出第四种：这条对话的会话在别的 agent 手里、当前 agent 根本
 * 不装载旧会话、以及 agent 那侧已经不认得这个会话号了。
 */
export type ThreadHistoryLoss = 'otherAgent' | 'notSupported' | 'forgotten'

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

/**
 * 一张挂在这条对话上的图片，以及它属于哪一句话。
 *
 * url 由原生侧拼好（`poietica-asset://asset/{thread}/{sha256}`），这一侧不
 * 自己拼：它的形状是协议的事，多一个人知道就多一处会漂移。
 */
export interface ThreadAttachment {
  readonly url: string
  /** 这是这条对话里第几条用户消息，从 0 数起，从末尾对齐。 */
  readonly turn: number
  /** 那条消息里的第几张，从 0 数起。 */
  readonly ordinal: number
}

/**
 * 一轮的两端，epoch 毫秒墙钟：这一轮什么时候发出去、什么时候落定。
 *
 * 它不在 events 里，也不该在：那段是 agent 交还的内容，而计时是这台机器
 * 记下的事实 —— 与 attachments 同一本账、同一把从末尾对齐的尺子
 *（record_prompt 发的轮次号）。
 */
export interface TurnSpanTiming {
  readonly turn: number
  readonly startedAt: number
  readonly endedAt: number
}

/** A conversation that was just opened, and what its session offers. */
export interface OpenedThread {
  readonly thread: ThreadRecord
  readonly selectors: readonly SessionConfigControl[]
  /**
   * 这条对话的经过，由持有它的 agent 交回来。
   *
   * unknown 是故意的：帧的形状由平台那一侧定义，这里不重新定义它，也不在这
   * 一层校验 —— 与运行帧走同一条规矩。收窄只发生在转录 store 的入口一处。
   *
   * 空不代表什么都没发生过。空有六种由来，下面那一格说的就是哪一种。
   */
  readonly events: readonly unknown[]
  /**
   * 这段经过为什么是现在这个样子。
   *
   * events 为空时，它是唯一能说清缘由的东西。此前六种情况在这一层全部长得
   * 一模一样——一个空数组——于是界面除了画一片空白之外无话可说。
   */
  readonly history: ThreadHistory
  /**
   * 这条对话挂着的图片。
   *
   * 它不在 events 里，也不该在：那一段是 agent 交还的对话，而图片是这台
   * 机器上用户自己的文件 —— agent 收到的只是一份 base64 副本，它没有义务
   * 交还，多数 CLI 也确实不交还。两个来源，一条时间线，在这里合。
   */
  readonly attachments: readonly ThreadAttachment[]
  /**
   * 这条对话每一轮的两端，本地账本记下的那些。
   *
   * 重放的帧不带原来的时刻（协议里没有这一格），所以封条的耗时由账本回答。
   */
  readonly spans: readonly TurnSpanTiming[]
  /**
   * 这条对话至今问过多少句话。
   *
   * 上面那些 turn 是照着它、并且是从末尾量起的。见 attachImages。
   */
  readonly prompts: number
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
   * 活的，但那条会话仍在 agent 那侧：原生侧因此走 ACP 的 session/load 把它装载
   * 回来，号不变，上下文因此还在。此前这里写的是"开一个新的并改写持有关系" ——
   * 那不是设计，那是一个把上下文丢掉、并且顺手覆盖掉旧号的 bug。
   *
   * 只有 agent 在握手时声明它不装载旧会话，才会真的新开一条。三种情况都在同
   * 一次答复里带回整张选择器表。
   */
  readonly open: (threadId?: ThreadId) => Promise<OpenedThread>
  /** Renames one. The name becomes the user's and outlives the agent's. */
  readonly rename?: (threadId: ThreadId, title: string) => Promise<void>
  readonly remove?: (threadId: ThreadId) => Promise<void>
  /** Archives or restores a conversation without deleting its history. */
  readonly archive?: (threadId: ThreadId, archived: boolean) => Promise<void>
  readonly setPinned?: (threadId: ThreadId, pinned: boolean) => Promise<void>
}
