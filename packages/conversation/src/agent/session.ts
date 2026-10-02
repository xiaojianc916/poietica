import type { AgentPromptResult } from '@poietica/contract/conversation'
import type { ThreadId } from './address'
import type { ApprovalAnswer } from './permission'
import type { QuestionResponse } from './question'
import type { TranscriptPort } from './transcript'

export interface PromptAsset {
  readonly sessionToken: string
  readonly assetToken: string
  readonly filename: string
  /** image：进内存注册表走预览；file：暂存在原生侧的通用文件，发 file part。 */
  readonly kind: 'image' | 'file'
}

export interface PromptSkill {
  readonly name: string
  readonly args?: string | undefined
}

export interface PromptConfiguration {
  readonly id: string
  readonly value: string
}

/**
 * 这句话怎么交给 agent —— 打断程度递减。
 *
 * - `turn`：开一轮（空闲时的正常发送）。
 * - `steer`：插进正在跑的那一轮，在工具批次之间被模型看到。
 * - `followUp`：不打断，这一轮跑完后自动作为下一轮输入。
 *
 * 两层的**队列归 agent**：本机不留副本，只看它报回来的队列快照。
 *
 * 上游还有第四档 `aside`（step 边界静默注入），本仓**不接**：上游既不报它排在哪，也不报
 * 它何时被吃掉 —— 屏幕上会留一行永远不消失的旁注。见 ADR 0034。
 */
export type PromptDelivery = 'turn' | 'steer' | 'followUp'

export interface AgentPromptRequest {
  readonly threadId: ThreadId
  readonly text: string
  readonly deliverAs: PromptDelivery
  readonly configuration: readonly PromptConfiguration[]
  readonly assets: readonly PromptAsset[]
  readonly skills: readonly PromptSkill[]
}

/** 待发队列此刻的样子，以及三个队列模式的取值。 */
export interface QueuedMessages {
  /** 这份队列属于哪条会话：屏幕按对话订阅，认领要用它。 */
  readonly sessionId: string
  readonly steering: readonly string[]
  readonly followUp: readonly string[]
  readonly steeringMode: MessageQueueMode
  readonly followUpMode: MessageQueueMode
  readonly interruptMode: 'immediate' | 'wait'
}

export type MessageQueueMode = 'all' | 'one-at-a-time'

/** 撤回交回来的那一句。空队列是 null，不是错。 */
export interface WithdrawnMessage {
  readonly text: string
}

/** 入队前就被取消的那一句：正文是**人打的原样**，号用来找它属于哪条对话。 */
export interface DroppedPrompt {
  readonly sessionId: string
  readonly text: string
}

/** 改队列模式；缺席的格不改。 */
export interface DeliveryModePatch {
  readonly steeringMode?: MessageQueueMode
  readonly followUpMode?: MessageQueueMode
  readonly interruptMode?: 'immediate' | 'wait'
}

export type AgentPromptHandle = Readonly<AgentPromptResult>

export interface AgentSessionPort {
  readonly transcript: TranscriptPort
  readonly prompt: (request: AgentPromptRequest) => Promise<AgentPromptHandle>
  readonly cancel: (threadId: ThreadId) => Promise<void>
  /**
   * 队列的两读一写。三条都只认「这条连接上那一条会话」：一次连接一条会话，
   * 号在这一层是多余的（与 selectors / goal 那两条同一形态）。
   */
  readonly readQueue: () => Promise<QueuedMessages>
  readonly withdraw: () => Promise<WithdrawnMessage | null>
  readonly setDeliveryModes: (patch: DeliveryModePatch) => Promise<QueuedMessages>
  /**
   * 队列变了（谁排了一句、谁撤回了一句、模型在哪一刻真的看见了它）。
   *
   * 队列的真相在 agent 里，这条只是把它此刻的样子推过来；读命令是同一条事实的
   * 另一个出口（刚绑上一条会话、断线重连时用它）。
   */
  readonly subscribeQueue: (listener: (queue: QueuedMessages) => void) => () => void
  /**
   * 这一句在入队前就被取消了（abort 或用量预检竞态），**没有落进会话文件**。
   *
   * 上游只在这两种竞态里响它（agent-session.ts:6588、6600）。收到就要把屏幕上那条
   * 乐观记录撤掉：不会有任何 transcript 帧来说明它怎么了。
   *
   * 带 `sessionId`：这条事件按会话到的，收账要走 `ownerOf` 找到它属于哪条对话 ——
   * 按正文在全部对话里找，等于让两条打了同一句话的对话互相认领。
   */
  readonly subscribePromptDropped: (listener: (dropped: DroppedPrompt) => void) => () => void
  readonly abortPrompt: (threadId: ThreadId, promptId: string) => Promise<void>
  readonly resolvePermission: (requestId: string, answer: ApprovalAnswer) => Promise<void>
  readonly answerQuestions: (response: QuestionResponse) => Promise<void>
  readonly dismissQuestions: (questionId: string) => Promise<void>
}
