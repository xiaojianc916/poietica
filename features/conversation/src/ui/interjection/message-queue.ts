import { invariant } from '@poietica/foundation'
import type {
  DeliveryModePatch,
  MessageQueueMode,
  QueuedDelivery,
  QueuedItem,
  QueuedMessages,
  WithdrawnMessage,
} from '../agent/session'

/**
 * 待发队列这一侧的看法。
 *
 * 队列**归 agent**：omp 的 steering / followUp 两个队列住在它的 Agent 里
 * （`getQueuedMessages` / `removeQueuedMessage` / `setSteeringMode`），本机不留副本
 * （AGENTS.md §1「每一类状态有且只有一个所有者」）。所以这一层只有三件事：读它报来的
 * 快照、订阅变化、把撤回与改模式交出去。
 *
 * 队列项带号（R-01 §3.8）：撤回与换层都按号点名，屏幕上画的那一行才是真的被操作的那一条。
 */
export interface MessageQueueState {
  readonly steering: readonly QueuedItem[]
  readonly followUp: readonly QueuedItem[]
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
  readonly withdraw: (itemId: string) => Promise<WithdrawnMessage | null>
  readonly move: (itemId: string, deliverAs: QueuedDelivery) => Promise<QueuedMessages>
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
   * 撤回一条还排着的输入，按号点名（R-01 §3.8）。
   *
   * 号不在队列里（已被 agent 消费、UI 快照落后）时端口交回 null；真的撤到了就把
   * 正文交给调用方（回输入框改）。上游按号连带取走紧挨在这句话前面的隐藏伴生消息。
   */
  withdraw = async (itemId: string): Promise<WithdrawnMessage | null> => {
    this.#active()
    try {
      return await this.#port.withdraw(itemId)
    } catch (cause) {
      this.#port.failed(cause)
      return null
    }
  }
  /** 换层：服务端用原始输入重新入队（附件 / 技能不丢），成功之后用返回的快照刷新。 */
  move = async (itemId: string, deliverAs: 'steer' | 'followUp'): Promise<void> => {
    this.#active()
    try {
      this.accept(await this.#port.move(itemId, deliverAs))
    } catch (cause) {
      this.#port.failed(cause)
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

function same(left: readonly QueuedItem[], right: readonly QueuedItem[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item.id === right[index]?.id && item.text === right[index]?.text)
  )
}
