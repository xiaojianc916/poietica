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
 * 放行只有一个判据：这一轮收口了，而且手上没有未落定的那一条 —— 轮次中途放一条
 * 出去，会把 agent 正在写的那一段从中间劈开。人按提交是唯一的例外：那是一次明说
 * 的插队，所以它也是唯一一条会去要求 kap 并轮的路径。
 *
 * 纯 TS：没有 React、没有 DOM、没有传输，所以它在 Node 里直接单测。
 */
export class InterjectionOutbox {
  readonly #port: OutboxPort
  readonly #woken = new Set<() => void>()
  #state: OutboxState = EMPTY
  #serial = 0
  /** 手上那条是插队放出去的：只有它要并进正在跑的这一轮。 */
  #urged = false
  /** 已经要求并轮的那个号：一个号只说一次。 */
  #merged: string | undefined

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

    if (this.#state.editing === id) {
      return said
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

  /** 提交：插到队首立刻放出去，并要求并进正在跑的这一轮。 */
  urge(id: string): void {
    this.arrange([id])
    this.#release(true)
  }

  /**
   * kap 收下了刚放出去那一条。
   *
   * 只有插队那一条要并轮，而且一个号只说一次：同一个号说第二遍时它已经不在 kap
   * 的队里，那条命令必然被回绝（40402）。
   */
  claimed(promptId: string): void {
    if (this.#state.inflight === undefined || !this.#urged || this.#merged === promptId) {
      return
    }

    this.#merged = promptId
    this.#port.merge(promptId)
  }

  /** 这一轮收口了：手上那条落账，队里下一条可以走。 */
  idle(): void {
    if (this.#state.inflight !== undefined) {
      this.#urged = false
      this.#merged = undefined
      this.#write({ inflight: undefined })
    }

    this.#drain()
  }

  /* 空闲才放行：轮次中途的停顿不是放行的时机。 */
  #drain(): void {
    if (this.#port.isBusy()) {
      return
    }

    this.#release(false)
  }

  /**
   * 放一条出去：队里第一句还在排的话。
   *
   * 跳过正在改的那一条，而不是停在它前面 —— 停下来等于有人在改队首时整队都发不出去。
   */
  #release(urged: boolean): void {
    if (this.#state.inflight !== undefined) {
      return
    }

    const index = this.#state.queue.findIndex((held) => held.state === 'queued')
    const said = this.#state.queue[index]

    if (said === undefined) {
      return
    }

    const queue = [...this.#state.queue]

    queue.splice(index, 1)
    this.#urged = urged
    this.#merged = undefined
    this.#write({ inflight: said, queue })
    this.#port.deliver(said)
  }

  /* 唤醒的判据只有一条：真相真的变了。同一份状态再写一遍不唤醒 —— 订阅者读的
  是这三格的引用，一次空唤醒就是一次谁都解释不了的重渲染。 */
  #write(written: Written): void {
    const next = { ...this.#state, ...written }

    if (
      next.queue === this.#state.queue &&
      next.inflight === this.#state.inflight &&
      next.editing === this.#state.editing
    ) {
      return
    }

    this.#state = next

    for (const wake of this.#woken) {
      wake()
    }
  }
}
