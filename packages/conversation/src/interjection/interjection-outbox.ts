import type {
  Interjection,
  OutboxPort,
  OutboxState,
  Said,
  SubmissionContext,
} from './interjection-contract'

const EMPTY: OutboxState = { queue: [], inflight: undefined, editing: undefined, paused: false }

export class InterjectionOutbox {
  readonly #port: OutboxPort
  readonly #listeners = new Set<() => void>()
  readonly #contexts = new Map<string, SubmissionContext>()
  #state: OutboxState = EMPTY
  #serial = 0
  #disposed = false

  constructor(port: OutboxPort) {
    this.#port = port
  }
  read = (): OutboxState => this.#state
  subscribe = (listener: () => void): (() => void) => {
    this.#active()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  say = (said: Said, context: SubmissionContext = {}): void => {
    this.#active()
    const editing = this.#state.editing
    const item: Interjection = {
      ...said,
      id: editing ?? `say-${String(++this.#serial)}`,
      state: 'queued',
    }
    this.#contexts.set(item.id, context)
    const queue =
      editing === undefined
        ? [...this.#state.queue, item]
        : this.#state.queue.map((entry) => (entry.id === editing ? item : entry))
    this.#write({ queue, editing: undefined, paused: false })
    this.#drain()
  }
  arrange = (order: readonly string[]): void => {
    this.#active()
    const remaining = new Map(this.#state.queue.map((item) => [item.id, item]))
    const queue: Interjection[] = []
    for (const id of order) {
      const item = remaining.get(id)
      if (item !== undefined) {
        queue.push(item)
        remaining.delete(id)
      }
    }
    queue.push(...remaining.values())
    if (queue.every((item, index) => item === this.#state.queue[index])) {
      return
    }
    this.#write({ queue })
  }
  checkout = (id: string): void => {
    this.#active()
    if (!this.#state.queue.some((item) => item.id === id)) {
      return
    }
    const queue = this.#state.queue.map((item): Interjection => {
      const state = item.id === id ? 'editing' : 'queued'
      return item.state === state ? item : { ...item, state }
    })
    this.#write({ queue, editing: id })
  }
  drop = (id: string): void => {
    this.#active()
    const queue = this.#state.queue.filter((item) => item.id !== id)
    if (queue.length === this.#state.queue.length) {
      return
    }
    this.#contexts.delete(id)
    this.#write({ queue, editing: this.#state.editing === id ? undefined : this.#state.editing })
  }
  urge = (id: string): void => {
    this.#active()
    if (!this.#state.queue.some((item) => item.id === id && item.state === 'queued')) {
      return
    }
    this.arrange([id])
    this.#write({ paused: false })
    this.#release(true)
  }
  dispose = (): void => {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    this.#contexts.clear()
    this.#listeners.clear()
    this.#write(EMPTY)
  }
  #active(): void {
    if (this.#disposed) {
      throw new Error('InterjectionOutbox is disposed.')
    }
  }
  #drain(): void {
    if (!this.#disposed && !this.#state.paused && this.#state.inflight === undefined) {
      this.#release(this.#port.isBusy())
    }
  }
  #release(steering: boolean): void {
    if (this.#disposed || this.#state.paused || this.#state.inflight !== undefined) {
      return
    }
    const item = this.#state.queue.find((entry) => entry.state === 'queued')
    if (item === undefined) {
      return
    }
    const context = this.#contexts.get(item.id)
    if (context === undefined) {
      throw new Error('Submission context is missing.')
    }
    this.#contexts.delete(item.id)
    this.#write({
      queue: this.#state.queue.filter((entry) => entry.id !== item.id),
      inflight: item,
    })
    void this.#dispatch(item, context, steering)
  }
  async #dispatch(
    item: Interjection,
    context: SubmissionContext,
    steering: boolean,
  ): Promise<void> {
    let accepted = false
    try {
      const promptId = await this.#port.deliver(item, context)
      if (this.#disposed || this.#state.inflight !== item) {
        return
      }
      if (promptId === null) {
        return
      }
      if (promptId.length === 0) {
        throw new Error('A delivery receipt requires a prompt ID.')
      }
      accepted = true
      if (steering) {
        await this.#port.merge(promptId)
      }
    } catch (cause) {
      if (!this.#disposed && this.#state.inflight === item) {
        this.#port.failed(cause)
      }
    } finally {
      if (!this.#disposed && this.#state.inflight === item) {
        // Acceptance transfers ownership; a failed steer must not replay the prompt.
        this.#write({ inflight: undefined, paused: !accepted })
        if (accepted) {
          this.#drain()
        }
      }
    }
  }
  #write(patch: Partial<OutboxState>): void {
    const next = { ...this.#state, ...patch }
    if (
      next.queue === this.#state.queue &&
      next.inflight === this.#state.inflight &&
      next.editing === this.#state.editing &&
      next.paused === this.#state.paused
    ) {
      return
    }
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }
}
