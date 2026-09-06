import {
  type AgentTranscriptSnapshot,
  itemId,
  TranscriptStore as OfficialTranscriptStore,
  type TranscriptOperation,
} from '@poietica/transcript'
import type { TranscriptPage, TranscriptPort, TranscriptSignal } from '../agent/transcript'

type Feed = { seq: number; valid: boolean; tail: Promise<void> }
type Publish = (agentId: string, snapshot: AgentTranscriptSnapshot) => void

function mergeBy<T>(
  earlier: readonly T[],
  current: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  const prefix = new Map(earlier.map((value) => [key(value), value]))
  for (const value of current) {
    prefix.delete(key(value))
  }
  return [...prefix.values(), ...current]
}

function olderSnapshot(
  earlier: TranscriptPage,
  current: AgentTranscriptSnapshot,
): AgentTranscriptSnapshot {
  return {
    ...current,
    items: mergeBy(earlier.items, current.items, itemId),
    tasks: mergeBy(earlier.tasks, current.tasks, (value) => value.taskId),
    interactions: mergeBy(
      earlier.interactions,
      current.interactions,
      (value) => value.interactionId,
    ),
    attachments: mergeBy(earlier.attachments, current.attachments, (value) => value.attachmentId),
    todos: mergeBy(earlier.todos, current.todos, (value) => value.todoId),
    prompts: mergeBy(earlier.prompts, current.prompts, (value) => value.promptId),
    hasMoreOlder: earlier.hasMoreOlder ?? false,
  }
}

/** One session owns its reducers and ordered recovery work; it owns no UI state. */
export class TranscriptReplica {
  readonly #transcript: OfficialTranscriptStore
  readonly #port: TranscriptPort
  readonly #publish: Publish
  readonly #feeds = new Map<string, Feed>()
  #disposed = false

  readonly sessionId: string

  constructor(sessionId: string, port: TranscriptPort, publish: Publish) {
    this.sessionId = sessionId
    this.#transcript = new OfficialTranscriptStore(sessionId)
    this.#port = port
    this.#publish = publish
  }

  snapshot(agentId: string): AgentTranscriptSnapshot | undefined {
    return this.#disposed ? undefined : this.#transcript.getAgent(agentId)?.snapshot()
  }

  dispose(): void {
    this.#disposed = true
    this.#feeds.clear()
  }

  seed(page: TranscriptPage): void {
    if (this.#disposed) {
      return
    }
    // Opening responses cannot replace a baseline owned by ongoing recovery.
    const feed = this.#feeds.get(page.agentId)
    if (feed !== undefined) {
      if (feed.valid) {
        this.#emit(page.agentId)
      }
      return
    }
    this.#install(page, false, this.#feed(page.agentId))
  }

  refresh(agentId: string): Promise<void> {
    return this.#queue(agentId, (feed) => this.#head(agentId, feed))
  }

  synchronize(agentId: string): Promise<void> {
    return this.#queue(agentId, (feed) => this.#catchUp(agentId, feed))
  }

  receive(signal: TranscriptSignal): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve()
    }
    if (signal.sessionId !== this.sessionId) {
      return Promise.reject(new Error('Transcript signal changed session identity.'))
    }
    if (signal.kind === 'resync') {
      return this.#resync()
    }
    if (signal.kind === 'reset') {
      return this.#restart(signal.agentId)
    }
    return this.#queue(signal.agentId, (feed) => this.#advance(signal, feed))
  }

  readEarlier(agentId: string, beforeTurn: string): Promise<void> {
    return this.#queue(agentId, async (feed) => {
      if (!feed.valid) {
        await this.#head(agentId, feed)
      }
      if (!this.#owns(agentId, feed)) {
        return
      }
      const page = await this.#read(agentId, feed, () =>
        this.#port.readTranscript(this.sessionId, agentId, beforeTurn),
      )
      if (page === undefined || !this.#owns(agentId, feed)) {
        return
      }
      this.#validate(page, agentId)
      this.#install(page, true, feed)
    })
  }

  #feed(agentId: string): Feed {
    const held = this.#feeds.get(agentId)
    if (held !== undefined) {
      return held
    }
    const created: Feed = { seq: 0, valid: false, tail: Promise.resolve() }
    this.#feeds.set(agentId, created)
    return created
  }

  #owns(agentId: string, feed: Feed): boolean {
    return !this.#disposed && this.#feeds.get(agentId) === feed
  }

  #restart(agentId: string): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve()
    }
    this.#feeds.delete(agentId)
    return this.refresh(agentId)
  }

  async #resync(): Promise<void> {
    const agents = new Set(this.#feeds.keys())
    this.#feeds.clear()
    const main = this.#feed('main')
    await this.refresh('main')
    if (!this.#owns('main', main)) {
      return
    }
    for (const descriptor of this.#transcript.agents()) {
      agents.add(descriptor.agentId)
    }
    agents.delete('main')
    await Promise.all([...agents].map((agentId) => this.refresh(agentId)))
  }

  async #read<T>(agentId: string, feed: Feed, request: () => Promise<T>): Promise<T | undefined> {
    if (!this.#owns(agentId, feed)) {
      return undefined
    }
    try {
      const value = await request()
      return this.#owns(agentId, feed) ? value : undefined
    } catch (cause) {
      // Only the owning generation may observe an I/O failure.
      if (this.#owns(agentId, feed)) {
        throw cause
      }
      return undefined
    }
  }

  #queue(agentId: string, action: (feed: Feed) => Promise<void>): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve()
    }
    const feed = this.#feed(agentId)
    const work = feed.tail.then(async () => {
      if (this.#owns(agentId, feed)) {
        await action(feed)
      }
    })
    // The caller retains the rejection, including failures from a successor recovery.
    feed.tail = work.then(
      () => undefined,
      () => undefined,
    )
    return work
  }

  async #advance(signal: Extract<TranscriptSignal, { kind: 'ops' }>, feed: Feed): Promise<void> {
    if (!Number.isSafeInteger(signal.seq) || signal.seq < 0) {
      throw new Error('Transcript event has an invalid sequence.')
    }
    if (feed.valid && signal.seq <= feed.seq) {
      return
    }
    if (!feed.valid || signal.seq !== feed.seq + 1) {
      await this.#catchUp(signal.agentId, feed)
      if (!this.#owns(signal.agentId, feed)) {
        return
      }
    }
    if (feed.valid && signal.seq <= feed.seq) {
      return
    }
    if (!feed.valid || signal.seq !== feed.seq + 1) {
      await this.#head(signal.agentId, feed, signal.seq)
      return
    }
    if (!this.#apply(signal.agentId, feed, signal.seq, signal.ops)) {
      await this.#head(signal.agentId, feed, signal.seq)
    }
  }

  async #catchUp(agentId: string, feed: Feed): Promise<void> {
    if (!feed.valid) {
      await this.#head(agentId, feed)
      return
    }
    const caught = await this.#read(agentId, feed, () =>
      this.#port.catchUpTranscript(this.sessionId, agentId, feed.seq),
    )
    if (caught === undefined || !this.#owns(agentId, feed)) {
      return
    }
    if (caught.agentId !== agentId) {
      throw new Error('Transcript catch-up changed agent identity.')
    }
    if (!Number.isSafeInteger(caught.latestSeq) || caught.latestSeq < 0) {
      throw new Error('Transcript catch-up has an invalid sequence.')
    }
    if (caught.latestSeq < feed.seq) {
      await this.#restart(agentId)
      return
    }
    let cursor = feed.seq
    const operations: TranscriptOperation[] = []
    let complete = caught.complete
    if (complete) {
      for (const batch of caught.batches) {
        if (!Number.isSafeInteger(batch.seq) || batch.seq < 0) {
          throw new Error('Transcript batch has an invalid sequence.')
        }
        if (batch.seq <= cursor) {
          continue
        }
        if (batch.seq !== cursor + 1 || batch.seq > caught.latestSeq) {
          complete = false
          break
        }
        operations.push(...batch.ops)
        cursor = batch.seq
      }
    }
    if (!complete || cursor !== caught.latestSeq) {
      feed.valid = false
      await this.#head(agentId, feed, caught.latestSeq)
      return
    }
    if (!this.#apply(agentId, feed, cursor, operations)) {
      await this.#head(agentId, feed, caught.latestSeq)
    }
  }

  #apply(
    agentId: string,
    feed: Feed,
    seq: number,
    operations: readonly TranscriptOperation[],
  ): boolean {
    if (operations.length === 0) {
      feed.seq = seq
      return true
    }
    const reducer = this.#transcript.ensureAgent(agentId)
    const checkpoint = reducer.snapshot()
    const result = reducer.receive(operations)
    if (result.gap !== undefined) {
      reducer.receive([{ op: 'reset', agentId, snapshot: checkpoint }])
      feed.valid = false
      return false
    }
    feed.seq = seq
    if (result.accepted.length > 0) {
      this.#emit(agentId)
    }
    return true
  }

  async #head(agentId: string, feed: Feed, minimumSeq = feed.seq): Promise<void> {
    const visible = this.#transcript.getAgent(agentId)?.snapshot().items ?? []
    const turns = visible.filter((item) => item.kind === 'turn')
    const boundary = turns[0]
    const head = await this.#read(agentId, feed, () =>
      this.#port.readTranscript(this.sessionId, agentId),
    )
    if (head === undefined || !this.#owns(agentId, feed)) {
      return
    }
    let page = head
    this.#validate(page, agentId)
    if (page.seq < minimumSeq) {
      throw new Error('Recovery snapshot did not cover the observed transcript gap.')
    }
    // A reset can carry an empty tail; restore the visible window through REST instead.
    while (page.hasMoreOlder) {
      const loaded = page.items.filter((item) => item.kind === 'turn')
      const first = loaded[0]
      if (
        loaded.length >= turns.length &&
        (boundary === undefined || (first !== undefined && first.ordinal <= boundary.ordinal))
      ) {
        break
      }
      if (first === undefined) {
        throw new Error('Transcript history has no pagination boundary.')
      }
      const earlier = await this.#read(agentId, feed, () =>
        this.#port.readTranscript(this.sessionId, agentId, first.turnId),
      )
      if (earlier === undefined || !this.#owns(agentId, feed)) {
        return
      }
      this.#validate(earlier, agentId)
      if (earlier.seq < page.seq) {
        throw new Error('Transcript history crossed a cursor reset.')
      }
      const expanded: TranscriptPage = { ...page, ...olderSnapshot(earlier, page) }
      const next = expanded.items.find((item) => item.kind === 'turn')
      if (
        expanded.hasMoreOlder &&
        (next === undefined || next.turnId === first.turnId || next.ordinal >= first.ordinal)
      ) {
        throw new Error('Transcript pagination did not advance.')
      }
      page = expanded
    }
    if (this.#owns(agentId, feed)) {
      this.#install(page, false, feed)
    }
  }

  #validate(page: TranscriptPage, agentId: string): void {
    if (page.agentId !== agentId) {
      throw new Error('Transcript snapshot changed agent identity.')
    }
    if (!Number.isSafeInteger(page.seq) || page.seq < 0) {
      throw new Error('Transcript snapshot has an invalid sequence.')
    }
  }

  #install(page: TranscriptPage, prepend: boolean, feed: Feed): void {
    if (!this.#owns(page.agentId, feed)) {
      return
    }
    this.#validate(page, page.agentId)
    if (!prepend && page.seq < feed.seq) {
      if (!feed.valid) {
        throw new Error('Recovery snapshot precedes the committed transcript cursor.')
      }
      return
    }
    for (const descriptor of page.agents) {
      this.#transcript.describeAgent(descriptor)
    }
    const reducer = this.#transcript.ensureAgent(page.agentId)
    const snapshot = prepend ? olderSnapshot(page, reducer.snapshot()) : page
    const applied = reducer.receive([{ op: 'reset', agentId: page.agentId, snapshot }])
    if (applied.gap !== undefined) {
      throw new Error('Official transcript reducer rejected a reset.')
    }
    if (!prepend) {
      feed.seq = page.seq
      feed.valid = true
    }
    this.#emit(page.agentId)
  }

  #emit(agentId: string): void {
    if (this.#disposed) {
      return
    }
    const reducer = this.#transcript.getAgent(agentId)
    if (reducer === undefined) {
      throw new Error('Transcript reducer has no owning agent.')
    }
    this.#publish(agentId, reducer.snapshot())
  }
}
