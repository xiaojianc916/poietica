import type { AgentPromptResult } from '@poietica/contract/conversation'
import type { ThreadId } from './address'
import type { ApprovalAnswer } from './permission'
import type { QuestionResponse } from './question'
import type { TranscriptPort } from './transcript'

/**
 * The agent session port.
 *
 * The implementation is Rust behind typed IPC: it owns the kap client, the agent
 * subprocess and every credential. This interface is the entire surface the UI
 * is allowed to know about.
 *
 * 屏幕经过从 transcript 端口来（官方 transcript 通道）；这个端口管的是正在
 * 发生的对话：说、停、并队、答。
 */

/**
 * 一张随这句话送出去的图片，按它在原生交付注册表里的位置点名。
 *
 * 字节不在这一层，也从不经过这一层。用户把文件放进输入框的那一刻它们就已经
 * 在原生侧了，这里拿着的只是取得它的两个令牌。所以这个包不认识 File，不认识
 * base64，也不认识 object URL —— 那些都是浏览器的东西，不是协议的东西。
 *
 * 协议本身要的 base64 由持有字节的那一侧编（见 commands/agent/attachment.rs 的
 * keep_bytes）：agent 是另一个进程，那一份省不掉，但它不该在 webview 与原生之间
 * 往返一趟。
 */
export interface PromptAsset {
  /** 这张图挂在哪条资产会话下。 */
  readonly sessionToken: string
  /** 它在那条会话里的令牌，也就是内容摘要。 */
  readonly assetToken: string
  /** 原始文件名，随 prompt 送去原生侧落库与上传（attachments.name）。 */
  readonly filename: string
}

export interface PromptSkill {
  readonly name: string
  readonly args?: string | undefined
}

/** A selector value committed before the prompt enters the agent. */
export interface PromptConfiguration {
  readonly id: string
  readonly value: string
}

export interface AgentPromptRequest {
  readonly threadId: ThreadId
  readonly text: string
  readonly configuration: readonly PromptConfiguration[]
  /**
   * 这一句带的图片。
   *
   * 与 text 是同一句话的两半：只有图、没有字，仍然是一句完整的话。没有附件
   * 时是空数组，而不是缺席 —— 一个「有时候不在」的字段会让每个读它的人都先
   * 判一次空。
   */
  readonly assets: readonly PromptAsset[]
  readonly skills: readonly PromptSkill[]
}

export type AgentPromptHandle = Readonly<AgentPromptResult>

export interface AgentSessionPort {
  /** 官方 transcript 通道：屏幕上的经过与它的推进都从这里来。 */
  readonly transcript: TranscriptPort
  readonly prompt: (request: AgentPromptRequest) => Promise<AgentPromptHandle>
  /**
   * 停掉这条对话上正在跑的那一轮。
   *
   * 点名一条对话，不是一轮。kap 的取消打给一条会话，而一条对话持有一条会话，
   * 这条对应关系在打开这条对话时就已经写下 —— 取消因此不需要在它之外再记住
   * 任何东西，也就没有什么会过期。
   */
  readonly cancel: (threadId: ThreadId) => Promise<void>
  /**
   * 把排队的那几句并进正在跑的那一轮。
   *
   * 队列归 agent，号由 prompt.queued 帧带来 —— 这一侧不留副本，所以这里收的是号，
   * 不是话。不中断在跑的那一轮，这是它与 cancel 的分野。
   */
  readonly steer: (threadId: ThreadId, promptIds: readonly string[]) => Promise<void>
  /** 撤掉一条还在排队的提问。在跑的那一轮一个字不动。 */
  readonly abortPrompt: (threadId: ThreadId, promptId: string) => Promise<void>
  /**
   * 答复一次审批。
   *
   * 词汇是 kap 的（approvalResponseSchema）：放行或拒绝，放行可以带上「这条
   * 会话都照此办理」。取消不在这里 —— 那是没有人回答时这一侧的收场。
   */
  readonly resolvePermission: (requestId: string, answer: ApprovalAnswer) => Promise<void>
  /**
   * 一组题一次答齐。
   *
   * kap 的一组最多四题，问是一起问的，答也一起答：逐题各发一次，agent 会在中间
   * 那些时刻看到一组只答了一半的题。
   */
  readonly answerQuestions: (response: QuestionResponse) => Promise<void>
  /**
   * 把一组题撤下，一题都不答。
   *
   * 与「每一题都选跳过」不是一件事：跳过是五种答复之一，agent 收到的仍是一组
   * 答案；撤下是这一组作罢，走 kap 自己的 :dismiss 后缀。
   */
  readonly dismissQuestions: (questionId: string) => Promise<void>
}
