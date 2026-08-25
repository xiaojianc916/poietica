import type { Interjection, OutboxPort, OutboxState, Said } from './interjection-contract'

const EMPTY: OutboxState = { editing: undefined, inflight: undefined, queue: [] }

interface Written {
  readonly queue?: readonly Interjection[]
  readonly inflight?: Interjection | undefined
  readonly editing?: string | undefined
}

/**
 * 待插话消息的有序出账簿。
 *
 * 顺序、编辑占位、以及「什么时候放一条出去」都归它。kap 的 pending 只被
 * enqueue / shift / splice 动过，协议没有重排操作，所以顺序的真相必须留在这一侧；
 * 代价是这一侧要守住「同时最多一条未落定」，否则两边各有一份顺序。
 *
 * 纯 TS：没有 React、没有 DOM、没有传输，所以它在 Node 里直接单测。
 */
export class InterjectionOutbox {
  readonly #port: OutboxPort
  readonly #woken = new Set<() => void>()
  #state: OutboxState = EMPTY
  #serial = 0

  constructor(port: OutboxPort) {
    this.#port = port
  }

  subscribe = (onChange: () => void): (() => void) => {
    this.#woken.add(onChange)

    return () => {
      this.#woken.delete(onChange)
    }
  }

  read = (): OutboxState => this.#state

  /**
   * 人说了一句话。
   *
   * 有一条正在编辑就是改它，改完回原位；否则排到队尾。空闲时立刻上路，所以
   * 不忙的时候队列根本不出现 —— 排队是插话的形态，不是发言的形态。
   */
  say(said: Said): void {
    const editing = this.#state.editing

    if (editing === undefined) {
      this.#serial += 1

      const id = `say-${String(this.#serial)}`

      this.#write({ queue: [...this.#state.queue, { ...said, id, state: 'queued' }] })
    } else {
      this.#write({
        editing: undefined,
        queue: this.#state.queue.map((held) =>
          held.id === editing ? { ...held, ...said, state: 'queued' as const } : held,
        ),
      })
    }

    this.#drain()
  }

  /** 整条顺序由界面交回，只认 id：拖动期间队首被放行也不会挪错人。 */
  arrange(order: readonly string[]): void {
    const held = new Map(this.#state.queue.map((item) => [item.id, item] as const))
    const moved: Interjection[] = []

    for (const id of order) {
      const item = held.get(id)

      if (item !== undefined) {
        held.delete(id)
        moved.push(item)
      }
    }

    const queue = [...moved, ...held.values()]

    if (queue.every((item, index) => item === this.#state.queue[index])) {
      return
    }

    this.#write({ queue })
  }

  /** 正文回输入框，位置留着。一次只有一条在改。 */
  checkout(id: string): Interjection | undefined {
    const said = this.#state.queue.find((held) => held.id === id)

    if (said === undefined) {
      return undefined
    }

    this.#write({
      editing: id,
      queue: this.#state.queue.map((held) => ({
        ...held,
        state: held.id === id ? ('editing' as const) : ('queued' as const),
      })),
    })

    return said
  }

  /** 不发这一句了。 */
  drop(id: string): void {
    const queue = this.#state.queue.filter((held) => held.id !== id)

    if (queue.length === this.#state.queue.length) {
      return
    }

    this.#write({
      queue,
      ...(this.#state.editing === id ? { editing: undefined } : {}),
    })
  }

  /** 提交：插到队首并立刻放出去，不等 agent 收口。 */
  urge(id: string): void {
    this.arrange([id])
    this.#release(0)
  }

  /** agent 刚收口一件事：放一条。 */
  beat(): void {
    this.#release(0)
  }

  /** kap 收下了刚放出去那一条：并进这一轮，别等下一轮。 */
  claimed(promptId: string): void {
    if (this.#state.inflight === undefined) {
      return
    }

    this.#port.merge(promptId)
  }

  /** 那一条落定了，下一条可以走了。 */
  settle(): void {
    if (this.#state.inflight === undefined) {
      return
    }

    this.#write({ inflight: undefined })
    this.#drain()
  }

  /* 空闲就把队首放出去：不忙的时候没有停顿可等。 */
  #drain(): void {
    if (this.#port.isBusy()) {
      return
    }

    this.#release(0)
  }

  #release(index: number): void {
    if (this.#state.inflight !== undefined) {
      return
    }

    const said = this.#state.queue[index]

    if (said === undefined || said.state !== 'queued') {
      return
    }

    const queue = [...this.#state.queue]

    queue.splice(index, 1)
    this.#write({ inflight: said, queue })
    this.#port.deliver(said)
  }

  #write(written: Written): void {
    this.#state = { ...this.#state, ...written }

    for (const wake of this.#woken) {
      wake()
    }
  }
}
