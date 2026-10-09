import type { Disposable } from '@poietica/foundation'
import type { TranscriptOperation, TranscriptPage } from '@poietica/transcript'
import type {
  ContextUsage,
  Controls,
  DeliverAs,
  Interaction,
  InteractionAnswer,
  ModelRef,
  Posture,
  QueueSnapshot,
  SessionState,
  UsageSample,
} from './values'

export interface OpenSessionSpec {
  readonly key: string // 调用方的稳定标识（conversation 用 threadId），用于日志和工具上下文
  readonly cwd: string // 工作区绝对路径
  readonly sessionFile: string | null // null = 新建会话
  readonly posture: Posture
  readonly model: ModelRef | null // null = 使用默认模型
  readonly thinking: string | null
}

export interface SubmitInput {
  readonly text: string
  readonly images: readonly { readonly path: string; readonly mime: string }[]
  readonly files: readonly { readonly path: string; readonly name: string }[]
  readonly skills: readonly string[]
  readonly deliverAs: DeliverAs
}

export type EngineSessionEvent =
  | { readonly type: 'timeline'; readonly agentId: string; readonly ops: readonly TranscriptOperation[] }
  | { readonly type: 'timelineReset'; readonly agentId: string } // 压缩（compaction）等导致必须整页重取
  | {
      readonly type: 'state'
      readonly state: SessionState
      readonly error: { readonly code: string; readonly message: string } | null
    }
  | { readonly type: 'interactionRequested'; readonly interaction: Interaction }
  | { readonly type: 'interactionResolved'; readonly interactionId: string }
  | { readonly type: 'queue'; readonly queue: QueueSnapshot }
  | { readonly type: 'controls'; readonly controls: Controls }
  /*
   * 上下文用量**单独一条通道**，不搭 controls 那班车。
   *
   * 十二页 §7.7 把 controls 定义成「控件变化」（模型 / 档位 / 姿态 / 模式），而用量是每轮
   * 都在涨的读数：搭同一班车意味着跑完一轮不重画，或者每轮重发一次整张控件表（含模型候选
   * 清单）。legacy 也是分开的两条（selectors 与 usage，见 bridge.ts 的 reselect / reportUsage）。
   *
   * 报 null 也是**一次有效报数**：「这条会话现在没有可报的窗口」与「还没报过」对屏幕是两件事
   * —— 前者要收掉已经画出来的圆环（换了没有窗口元数据的模型），后者是首帧。所以这一支收
   * nullable，而 controls.context 那一格仍然只是初值。
   */
  | { readonly type: 'contextUsage'; readonly usage: ContextUsage | null }
  | { readonly type: 'usage'; readonly usage: UsageSample }
  | { readonly type: 'promptDropped'; readonly text: string } // omp 丢弃了一条用户输入，必须告诉用户

export interface EngineSession {
  readonly sessionId: string
  readonly sessionFile: string
  state(): SessionState
  isBusy(): boolean // running 或者有待答交互
  subscribe(listener: (event: EngineSessionEvent) => void): Disposable
  submit(input: SubmitInput): Promise<void> // turn：开始一轮后立即返回；steer / followUp：入队后返回
  cancel(): Promise<void>
  queue(): QueueSnapshot
  withdraw(queueItemId: string): void
  setQueueModes(modes: Partial<QueueSnapshot['modes']>): void
  controls(): Controls
  setModel(model: ModelRef): Promise<void>
  setThinking(level: string): void
  setPosture(posture: Posture): void
  setPlanMode(enabled: boolean): Promise<void>
  setGoal(goal: string | null): Promise<void>
  interactions(): readonly Interaction[]
  respond(interactionId: string, answer: InteractionAnswer): void
  page(agentId: string, beforeTurnId: string | null): Promise<TranscriptPage>
  dispose(): Promise<void>
}
