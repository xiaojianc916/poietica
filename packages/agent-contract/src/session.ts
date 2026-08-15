import type { ThreadId } from './address'
import type { AcpSessionId } from './protocol'
import type { RunEvent } from './run'

/**
 * The agent session port.
 *
 * The implementation is Rust behind typed IPC: it owns the ACP client, the agent
 * subprocess and every credential. This interface is the entire surface the UI
 * is allowed to know about.
 *
 * 历史不从这里来。一条对话的经过由持有它的 agent 在 session/load 期间重放，
 * 随打开这条对话的那次答复一起交回（见 thread.ts 的 OpenedThread.events）。
 * 这个端口只管正在发生的事。
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
}

export interface AgentPromptRequest {
  readonly threadId: ThreadId
  readonly text: string
  /**
   * 这一句带的图片。
   *
   * 与 text 是同一句话的两半：只有图、没有字，仍然是一句完整的话。没有附件
   * 时是空数组，而不是缺席 —— 一个「有时候不在」的字段会让每个读它的人都先
   * 判一次空。
   */
  readonly assets: readonly PromptAsset[]
}

/**
 * 这一轮发到了哪条会话。
 *
 * 一格，原生侧才说得出的事实。图片地址不从这里回来：它随这一轮的 run_started
 * 帧走，与那句话的文字同一条路（见 frame.rs 的 RunStarted）。取消只需要点名一
 * 条对话，见下面的 cancel。
 */
export interface AgentPromptHandle {
  readonly sessionId: AcpSessionId
}

export interface AgentSessionPort {
  /**
   * Emits one batch of run events with the session they all belong to; returns
   * an unsubscribe function.
   *
   * 一批就是原生侧一拍里攒下的帧（见 commands/agent/turn.rs 的 batched）。一批
   * 只属于一条会话：批随每一轮 prompt 新造，Frames::new 在造它的那一刻就把会话
   * 号钉死了。所以地址对整批说一次就够，不必逐帧再说一遍。
   *
   * 地址是会话号，和 ACP 的 session/update 同一个主语。它由原生侧写在信封上
   * （frame.rs 的 Envelope.session_id），六种帧无一例外，所以订阅者不必猜。
   *
   * 它先于帧存在：一条对话在打开的那一刻就握住了会话号（ThreadRecord.sessionId），
   * 而帧是此后才发生的事。
   *
   * seq 按会话单调，所以按 seq 去重在两轮之间仍然成立。
   */
  readonly subscribe: (
    listener: (events: readonly RunEvent[], sessionId: AcpSessionId) => void,
  ) => () => void
  readonly prompt: (request: AgentPromptRequest) => Promise<AgentPromptHandle>
  /**
   * 停掉这条对话上正在跑的那一轮。
   *
   * 点名一条对话，不是一轮。ACP 的取消发给一条会话，而一条对话持有一条会话，
   * 这条对应关系在打开这条对话时就已经写下 —— 取消因此不需要在它之外再记住
   * 任何东西，也就没有什么会过期。
   */
  readonly cancel: (threadId: ThreadId) => Promise<void>
  readonly resolvePermission: (requestId: string, optionId: string) => Promise<void>
}
