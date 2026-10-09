import type { ThreadId } from './address'
import type { AgentPromptResult } from './dto'
import type { ApprovalAnswer } from './permission'
import type { PlanAnswer } from './plan'
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
  /**
   * 提交号（「Core 即时回显」方案）：UI 铸号、随 `turns.submit` 交给 Core，
   * Core 回显的那条记录带着同一个号。界面靠它把提交行与真实 turn 认成同一条。
   */
  readonly clientTurnId?: string
}

/** 待发队列此刻的样子，以及三个队列模式的取值。 */
export interface QueuedMessages {
  /**
   * 这份队列属于哪条对话。
   *
   * 端口在这一层就是**按对话**建的一根（`stores/session-port.ts` 的头注），所以这里
   * 报的与订阅它的那条对话是同一个号 —— 它只用来辨认「这份快照是不是我的」，
   * 不当作会话文件的号用（那个号是引擎侧的 `sessionFile`）。
   */
  readonly threadId: string
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
  readonly threadId: string
  readonly text: string
}

/**
 * 本机判定的一轮失败（agent 连接断开、进程没了）。
 *
 * `message` 是原生侧写好的那句人话（`book.fail_active` 给的那一条），原样上屏：
 * 它是这条事实唯一说得清「为什么」的地方，这一层不再编第二句。
 */
export interface RunFailed {
  readonly threadId: string
  readonly message: string
  /**
   * 这一轮**跑完了**，只是本机的帧记录掉了帧。
   *
   * 与「这一轮失败了」分开：两者都要收尾（那一轮都不会再有帧了），
   * 但只有后者该报错 —— 这里的 `message` 是内部诊断，不是给人看的话。
   */
  readonly degraded: boolean
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
  /**
   * 本机判定的轮终失败：agent 连接断开、进程没了。
   *
   * **这不是 agent 说的，是我们自己发现的**。屏幕上的轮终只认 agent 的 transcript，
   * 而 agent 已经死了 —— 那条通道再也不会有帧。不收这一条，那一轮就永远转下去：
   * 没有错误、没有发送键、只能重启应用。
   *
   * 带 `sessionId`：按会话认领（与 `subscribePromptDropped` 同一条理由）。
   */
  readonly subscribeRunFailed: (listener: (failed: RunFailed) => void) => () => void
  readonly abortPrompt: (threadId: ThreadId, promptId: string) => Promise<void>
  readonly resolvePermission: (requestId: string, answer: ApprovalAnswer) => Promise<void>
  /** 答一张计划卡片（04 页 §3.12 第 5 支）。 */
  readonly resolvePlan: (interactionId: string, answer: PlanAnswer) => Promise<void>
  readonly answerQuestions: (response: QuestionResponse) => Promise<void>
  readonly dismissQuestions: (questionId: string) => Promise<void>
}
