import type {
  AgentPromptHandle,
  AgentPromptRequest,
  AgentSessionPort,
  KapSessionId,
  QuestionResponse,
  RunEvent,
} from '@poietica/agent-contract'

/**
 * A session port backed by the Rust runtime.
 *
 * The bridge is injected rather than imported: the feature layer declares the
 * port it needs and the platform layer supplies it, so nothing here depends on
 * a desktop runtime and the whole adapter is unit-testable.
 *
 * 帧不在这里重新校验一遍。
 *
 * 不可信的那一侧是 agent 子进程与原生运行时之间，而那里已经由官方 SDK 的类型
 * 反序列化把关：畸形帧到不了 recorder。到这里的每一帧都出自 frame.rs 里那个
 * 强类型 enum，形状由 Rust 编译期保证。对自己进程的输出再写一份运行期 schema，
 * 换不到安全，只换来第三份要同步的协议描述 —— 以及一个真实的故障模式：一个
 * 封闭形状的校验器遇到协议新增的字段就会把整轮判成「无法解析」，而回放历史时
 * 那些帧会被静默丢弃。
 *
 * 所以这一层只做一件事：把线上的值断言成端口契约，一次，在这里。
 */

export interface AgentEventSource {
  /** Hands out one batch of frames and the session they all belong to. */
  readonly listen: (
    handler: (payload: readonly unknown[], sessionId: KapSessionId) => void,
  ) => () => void
}

export interface AgentCommandBridge {
  readonly prompt: (request: AgentPromptRequest) => Promise<{ readonly sessionId: string }>
  readonly cancel: (threadId: string) => Promise<void>
  readonly resolvePermission: (requestId: string, optionId: string) => Promise<void>
  readonly answerQuestions: (response: QuestionResponse) => Promise<void>
  readonly dismissQuestions: (questionId: string) => Promise<void>
}

export interface IpcSessionOptions {
  readonly bridge: AgentCommandBridge
  readonly source: AgentEventSource
}

export function createIpcSession({ bridge, source }: IpcSessionOptions): AgentSessionPort {
  return {
    subscribe: (listener) =>
      source.listen((payload, sessionId) => {
        listener(payload as readonly RunEvent[], sessionId)
      }),

    prompt: async (request): Promise<AgentPromptHandle> => {
      const { sessionId } = await bridge.prompt(request)

      return { sessionId }
    },

    cancel: (threadId) => bridge.cancel(threadId),

    resolvePermission: (requestId, optionId) => bridge.resolvePermission(requestId, optionId),

    answerQuestions: (response) => bridge.answerQuestions(response),

    dismissQuestions: (questionId) => bridge.dismissQuestions(questionId),
  }
}
