import type { ThreadId } from './address'
import type { DialogAnswer } from './dialog'
import type { AgentPromptResult } from './dto'
import type { ApprovalAnswer } from './permission'
import type { PlanAnswer } from './plan'
import type { QuestionResponse } from './question'
import type { TranscriptPort } from './transcript'

export interface PromptAsset {
  readonly sessionToken: string
  readonly assetToken: string
  readonly filename: string
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
 * 这句话怎么交给 agent —— 打断程度递减：`turn` 开一轮，`steer` 插进正在跑的那一轮，`followUp` 等这轮跑完再跑。
 * 队列归 agent，本机不留副本；上游第四档 `aside` 不接：它既不报排在哪、也不报何时被吃掉，屏幕上会留一行永不消失的旁注（ADR 0034）。
 */
export type PromptDelivery = 'turn' | 'steer' | 'followUp'

export type QueuedDelivery = 'steer' | 'followUp'

export interface AgentPromptRequest {
  readonly threadId: ThreadId
  readonly text: string
  readonly deliverAs: PromptDelivery
  readonly configuration: readonly PromptConfiguration[]
  readonly assets: readonly PromptAsset[]
  readonly skills: readonly PromptSkill[]
  /** UI 铸号随 `turns.submit` 交给 Core，Core 回显带同一个号：界面靠它把提交行与真实 turn 认成同一条。 */
  readonly clientTurnId?: string
}

/** 排队那一句带的附件：形状与 `DraftAttachment` 相同，撤回时原样交回输入框；图片的 `previewUrl` 也是队列条缩略图的来源。 */
export interface QueuedAttachment {
  readonly id: string
  readonly name: string
  readonly kind: 'image' | 'file'
  readonly previewUrl: string | null
}

/** 号与正文一起在 UI 里走：撤回 / 换层都按号点名，只拿正文会撤错行（R-01 §1 缺陷 D）。 */
export interface QueuedItem {
  readonly id: string
  readonly text: string
  readonly attachments: readonly QueuedAttachment[]
}

export interface QueuedMessages {
  /** 这根端口按对话建，这里报的号只用来辨认「这份快照是不是我的」，不是会话文件的号（那个是 `sessionFile`）。 */
  readonly threadId: string
  readonly steering: readonly QueuedItem[]
  readonly followUp: readonly QueuedItem[]
  readonly steeringMode: MessageQueueMode
  readonly followUpMode: MessageQueueMode
  readonly interruptMode: 'immediate' | 'wait'
}

export type MessageQueueMode = 'all' | 'one-at-a-time'

/** 撤回交回来的那一句（正文 + 附件，一起回输入框）。空队列是 null，不是错。 */
export interface WithdrawnMessage {
  readonly text: string
  readonly attachments: readonly QueuedAttachment[]
}

/** 正文是**人打的原样**，号用来找它属于哪条对话。 */
export interface DroppedPrompt {
  readonly threadId: string
  readonly text: string
}

/** 本机判定的一轮失败（连接断开、进程没了）。`message` 是原生侧写好的那句人话，原样上屏。 */
export interface RunFailed {
  readonly threadId: string
  readonly message: string
  /** 这一轮**跑完了**、只是本机掉了帧：与「失败」一起收尾，但只有后者该报错 —— 这里的 `message` 是内部诊断。 */
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
  /** 队列的两读一写。三条都只认「这条连接上那一条会话」：一次连接一条会话，号在这一层是多余的。 */
  readonly readQueue: () => Promise<QueuedMessages>
  /** 按号撤回一条排队项；号不在最新快照里（已被 agent 消费或 UI 落后）返回 null。 */
  readonly withdraw: (itemId: string) => Promise<WithdrawnMessage | null>
  /** 换层：服务端用原始输入重新入队，附件 / 文件 / 技能都保留，返回新快照。 */
  readonly move: (itemId: string, deliverAs: QueuedDelivery) => Promise<QueuedMessages>
  readonly setDeliveryModes: (patch: DeliveryModePatch) => Promise<QueuedMessages>
  /** 队列变了；真相在 agent 里，这条只是把此刻的样子推过来，刚绑上会话或断线重连时用读命令。 */
  readonly subscribeQueue: (listener: (queue: QueuedMessages) => void) => () => void
  /** 这一句在入队前就被取消（abort 或用量预检竞态），**没有落进会话文件**：收到就撤掉屏幕上那条乐观记录，不会有帧来说明它。收账按 `sessionId` 走 `ownerOf` 认领，按正文找会让两条打了同一句话的对话互相认领。 */
  readonly subscribePromptDropped: (listener: (dropped: DroppedPrompt) => void) => () => void
  /** 轮终失败**不是 agent 说的，是我们自己发现的**：不收这一条，那一轮就永远转下去（没有错误、没有发送键、只能重启应用）。按 `sessionId` 认领。 */
  readonly subscribeRunFailed: (listener: (failed: RunFailed) => void) => () => void
  readonly abortPrompt: (threadId: ThreadId, promptId: string) => Promise<void>
  readonly resolvePermission: (requestId: string, answer: ApprovalAnswer) => Promise<void>
  readonly resolvePlan: (interactionId: string, answer: PlanAnswer) => Promise<void>
  readonly answerQuestions: (response: QuestionResponse) => Promise<void>
  /** 单问（确认 / 单选 / 输入）按它自己的种类答（Q1-E）；撤下仍走 `dismissQuestions`。 */
  readonly answerDialog: (interactionId: string, answer: DialogAnswer) => Promise<void>
  readonly dismissQuestions: (questionId: string) => Promise<void>
}
