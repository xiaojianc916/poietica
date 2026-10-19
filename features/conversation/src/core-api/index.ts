import { type CoreEvent, defineCoreEvent } from '@poietica/core-kernel/events'
import type { ModelRef, Posture, UsageSample } from '@poietica/engine'
import { type Disposable, defineServiceToken } from '@poietica/foundation'
import type { Thread } from '../contract'

export interface ConversationService {
  createThread(init: {
    workspaceId: string
    title: string
    origin: 'user' | 'automation'
    posture: Posture
    model: ModelRef | null
    thinking: string | null
  }): Thread
  /** 等价于 turns.submit（deliverAs:'turn'，无附件、无技能） */
  submit(input: { threadId: string; text: string }): Promise<void>
  cancel(threadId: string): Promise<void>
  get(threadId: string): Thread | null
}
export const ConversationServiceToken = defineServiceToken<ConversationService>('conversation', 'ConversationService')

export interface TurnSettled {
  readonly threadId: string
  readonly outcome: 'completed' | 'cancelled' | 'failed'
  readonly error: { code: string; message: string } | null
}
export const turnSettled: CoreEvent<TurnSettled> = defineCoreEvent<TurnSettled>('conversation', 'turnSettled')

/**
 * 一句话没能交给 omp（冷打开失败、引擎在开轮前拒收、被判 dropped、Core 重启）。
 *
 * 「Core 即时回显」之后，提交有独立于轮次的生命周期：`failed` 这个结局**不经过任何一轮**，
 * 所以不会有 turnSettled。这条事件就是那个结局的广播 —— automations 靠它把「永远运行中」
 * 的运行记录收口（R-06）。
 */
export interface SubmissionFailed {
  readonly threadId: string
  readonly clientTurnId: string
  readonly deliverAs: 'turn' | 'steer' | 'followUp'
  readonly error: { readonly code: string; readonly message: string }
}
export const submissionFailed: CoreEvent<SubmissionFailed> = defineCoreEvent<SubmissionFailed>(
  'conversation',
  'submissionFailed',
)

/** 线程被删除（用户删除 / 工作区级联）：按线程索引的订阅方靠它清账 */
export interface ThreadRemoved {
  readonly threadId: string
}
export const threadRemoved: CoreEvent<ThreadRemoved> = defineCoreEvent<ThreadRemoved>('conversation', 'threadRemoved')

export interface UsageSampled {
  readonly threadId: string
  readonly sample: UsageSample
  readonly at: number
}
export const usageSampled: CoreEvent<UsageSampled> = defineCoreEvent<UsageSampled>('conversation', 'usageSampled')

/**
 * 用户发出去了一句话（准入）。
 *
 * legacy 的对应物是账本里的 turn_admissions：每落一行就是用户说出来的一句，插话也算
 * ——ADR 0039 把它定成用量页「消息数量」那一格的唯一口径（不是模型采样条数）。
 * 新架构里「一句话进没进会话」只有 conversation 知道（它拿着回合的准入），所以这件事
 * 由这里发出来，用量功能的 core 订阅后落进自己的日账（与 usageSampled 同一条路）。
 */
export interface UserMessageSubmitted {
  readonly threadId: string
  readonly at: number
}
export const userMessageSubmitted: CoreEvent<UserMessageSubmitted> = defineCoreEvent<UserMessageSubmitted>(
  'conversation',
  'userMessageSubmitted',
)

/**
 * 轮次上下文登记处：别的功能把「下一句话要顺带告诉模型的事」交给 conversation（例如 intelligent-ui
 * 交出对话内界面的最新状态）。conversation 不认识具体内容，只在把一句话交给引擎的那一刻同步问一遍
 * 全部提供方，结果作为 `SubmitInput.context` 交出去 —— 只进模型的上下文，不画进气泡。
 *
 * 只在交接成功后才回调 `delivered`：交接失败（冷打开失败、引擎拒收、开轮时被引擎丢掉）那一句没送达，
 * 提供方的内容下一句再带。排队的那一句（插话 / 排队发送）引擎收下就算交出，之后若被丢弃或撤回，
 * 再回调 `undelivered`：提供方把「已交」退回去，内容同样留给下一句。
 */
export interface TurnContextPart {
  /** 给模型看的原文；引擎负责把它包起来、拆不开外层的标记 */
  readonly text: string
  readonly delivered: () => void
  /** 交出之后又没送到（排队项被丢弃 / 撤回）：撤销 `delivered` 记下的那一笔。缺省 = 不撤 */
  readonly undelivered?: () => void
}
export interface TurnContextProvider {
  /** 提供方的功能 id：同时是交给模型时的来源标签，一个功能只能登记一次 */
  readonly id: string
  /** **同步**：交接一路同步走到引擎。没有要说的就回 null */
  collect(threadId: string): TurnContextPart | null
}
export interface TurnContextRegistry {
  register(provider: TurnContextProvider): Disposable
}
export const TurnContextRegistryToken = defineServiceToken<TurnContextRegistry>('conversation', 'TurnContextRegistry')
