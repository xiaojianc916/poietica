import { invariant } from '@poietica/foundation'
import type { DeliveryModePatch, MessageQueueMode, QueuedMessages, WithdrawnMessage } from '../agent/session'

/**
 * 待发队列这一侧的看法。
 *
 * 队列**归 agent**：omp 的 steering / followUp 两个队列住在它的 Agent 里
 * （`getQueuedMessages` / `popLastQueuedMessage` / `setSteeringMode`），本机不留副本
 * （AGENTS.md §1「每一类状态有且只有一个所有者」）。所以这一层只有三件事：读它报来的
 * 快照、订阅变化、把撤回与改模式交出去。
 */
export interface MessageQueueState {
  readonly steering: readonly string[]
  readonly followUp: readonly string[]
  readonly steeringMode: MessageQueueMode
  readonly followUpMode: MessageQueueMode
  readonly interruptMode: 'immediate' | 'wait'
}

export const EMPTY_QUEUE: MessageQueueState = {
  steering: [],
  followUp: [],
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  interruptMode: 'immediate',
}

/** 出队的动作交给端口；这一层不替 agent 改自己的队列。 */
export interface MessageQueuePort {
  readonly withdraw: () => Promise<WithdrawnMessage | null>
  readonly setModes: (patch: DeliveryModePatch) => Promise<QueuedMessages>
  readonly failed: (cause: unknown) => void
}

export class MessageQueue {
  readonly #port: MessageQueuePort
  readonly #listeners = new Set<() => void>()
  #state: MessageQueueState = EMPTY_QUEUE
  #disposed = false

  constructor(port: MessageQueuePort) {
    this.#port = port
  }
  read = (): MessageQueueState => this.#state
  subscribe = (listener: () => void): (() => void) => {
    this.#active()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  /** agent 报来的快照。引用不变就不通知 —— 订阅者按这个引用判有没有变。 */
  accept = (queue: QueuedMessages): void => {
    if (this.#disposed) {
      return
    }
    this.#write({
      steering: [...queue.steering],
      followUp: [...queue.followUp],
      steeringMode: queue.steeringMode,
      followUpMode: queue.followUpMode,
      interruptMode: queue.interruptMode,
    })
  }
  /**
   * 撤回最后一条还排着的插话（LIFO，上游只有这一种撤回）。
   *
   * 撤回哪一条由 agent 决定 —— 它先看 steering 再看 followUp，还会连带取走紧挨在
   * 这句话前面的隐藏伴生消息。这里只把正文交给调用方（回输入框改）。
   */
  withdraw = async (): Promise<WithdrawnMessage | null> => {
    this.#active()
    try {
      return await this.#port.withdraw()
    } catch (cause) {
      this.#port.failed(cause)
      return null
    }
  }
  configure = async (patch: DeliveryModePatch): Promise<void> => {
    this.#active()
    try {
      this.accept(await this.#port.setModes(patch))
    } catch (cause) {
      this.#port.failed(cause)
    }
  }
  dispose = (): void => {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    this.#listeners.clear()
    this.#state = EMPTY_QUEUE
  }
  #active(): void {
    if (this.#disposed) {
      invariant(false, 'MessageQueue is disposed.')
    }
  }
  #write(next: MessageQueueState): void {
    const held = this.#state
    if (
      same(held.steering, next.steering) &&
      same(held.followUp, next.followUp) &&
      held.steeringMode === next.steeringMode &&
      held.followUpMode === next.followUpMode &&
      held.interruptMode === next.interruptMode
    ) {
      return
    }
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((text, index) => text === right[index])
}
