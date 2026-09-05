import {
  type AgentTranscriptSnapshot,
  itemId,
  TranscriptStore as OfficialTranscriptStore,
} from '@poietica/transcript'
import type { TranscriptPage, TranscriptPort, TranscriptSignal } from '../agent/transcript'

type Feed = { seq: number; valid: boolean }
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
  readonly #queues = new Map<string, Promise<void>>()
  #disposed = false

  readonly sessionId: string

  constructor(sessionId: string, port: TranscriptPort, publish: Publish) {
    this.sessionId = sessionId
    this.#transcript = new OfficialTranscriptStore(sessionId)
    this.#port = port
    this.#publish = publish
  }

  dispose(): void {
    this.#disposed = true
    this.#queues.clear()
    this.#feeds.clear()
  }

  seed(page: TranscriptPage): void {
    this.#install(page, false)
  }

  refresh(agentId: string): Promise<void> {
    return this.#queue(agentId, () => this.#head(agentId))
  }

  synchronize(agentId: string): Promise<void> {
    return this.#queue(agentId, () => this.#catchUp(agentId))
  }

  receive(signal: TranscriptSignal): Promise<void> {
    if (signal.sessionId !== this.sessionId) {
      return Promise.reject(new Error('Transcript signal changed session identity.'))
    }
    if (signal.kind === 'resync') {
      const agents = this.#feeds.size === 0 ? ['main'] : [...this.#feeds.keys()]
      return Promise.all(agents.map((agentId) => this.refresh(agentId))).then(() => undefined)
    }
    return this.#queue(signal.agentId, () => this.#advance(signal))
  }

  readEarlier(agentId: string, beforeTurn: string): Promise<void> {
    return this.#queue(agentId, async () => {
      if (!this.#feeds.get(agentId)?.valid) {
        await this.#head(agentId)
      }
      if (this.#disposed) {
        return
      }
      const page = await this.#port.readTranscript(this.sessionId, agentId, beforeTurn)
      if (this.#disposed) {
        return
      }
      if (page.agentId !== agentId) {
        throw new Error('Transcript history changed agent identity.')
      }
      this.#install(page, true)
    })
  }

  #queue(agentId: string, action: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(agentId) ?? Promise.resolve()
    const work = previous.then(async () => {
      if (!this.#disposed) {
        await action()
      }
    })
    // The continuation keeps the lane usable; the original rejection goes to its caller.
    const tail = work.then(
      () => undefined,
      () => undefined,
    )
    this.#queues.set(agentId, tail)
    void tail.then(() => {
      if (this.#queues.get(agentId) === tail) {
        this.#queues.delete(agentId)
      }
    })
    return work
  }

  async #advance(signal: Extract<TranscriptSignal, { kind: 'ops' }>): Promise<void> {
    if (!Number.isSafeInteger(signal.seq) || signal.seq < 0) {
      throw new Error('Transcript event has an invalid sequence.')
    }
    let feed = this.#feeds.get(signal.agentId)
    if (feed?.valid && signal.seq <= feed.seq) {
      return
    }
    if (!feed?.valid || signal.seq !== feed.seq + 1) {
      await this.#catchUp(signal.agentId)
      if (this.#disposed) {
        return
      }
      feed = this.#feeds.get(signal.agentId)
    }
    if (feed?.valid && signal.seq <= feed.seq) {
      return
    }
    if (!feed?.valid || signal.seq !== feed.seq + 1) {
      await this.#head(signal.agentId)
      if (!this.#disposed && (this.#feeds.get(signal.agentId)?.seq ?? -1) < signal.seq) {
        throw new Error('Recovery snapshot did not cover the observed transcript gap.')
      }
      return
    }
    const reducer = this.#transcript.ensureAgent(signal.agentId)
    const result = reducer.receive(signal.ops)
    if (result.gap !== undefined) {
      feed.valid = false
      await this.#head(signal.agentId)
      return
    }
    feed.seq = signal.seq
    this.#emit(signal.agentId)
  }

  async #catchUp(agentId: string): Promise<void> {
    const initial = this.#feeds.get(agentId)
    if (!initial?.valid) {
      await this.#head(agentId)
      return
    }
    const caught = await this.#port.catchUpTranscript(this.sessionId, agentId, initial.seq)
    if (this.#disposed) {
      return
    }
    const feed = this.#feeds.get(agentId)
    if (feed === undefined) {
      return
    }
    if (!caught.complete || caught.agentId !== agentId || caught.latestSeq < initial.seq) {
      await this.#head(agentId)
      return
    }
    const reducer = this.#transcript.ensureAgent(agentId)
    let changed = false
    for (const batch of caught.batches) {
      if (batch.seq <= feed.seq) {
        continue
      }
      if (batch.seq !== feed.seq + 1 || batch.seq > caught.latestSeq) {
        feed.valid = false
        await this.#head(agentId)
        return
      }
      const result = reducer.receive(batch.ops)
      if (result.gap !== undefined) {
        feed.valid = false
        await this.#head(agentId)
        return
      }
      feed.seq = batch.seq
      changed = true
    }
    if (feed.seq < caught.latestSeq) {
      feed.valid = false
      await this.#head(agentId)
      return
    }
    if (changed) {
      this.#emit(agentId)
    }
  }

  async #head(agentId: string): Promise<void> {
    const page = await this.#port.readTranscript(this.sessionId, agentId)
    if (this.#disposed) {
      return
    }
    if (page.agentId !== agentId) {
      throw new Error('Transcript snapshot changed agent identity.')
    }
    this.#install(page, false)
  }

  #install(page: TranscriptPage, prepend: boolean): void {
    if (this.#disposed) {
      return
    }
    if (!Number.isSafeInteger(page.seq) || page.seq < 0) {
      throw new Error('Transcript snapshot has an invalid sequence.')
    }
    const feed = this.#feeds.get(page.agentId)
    if (!prepend && feed !== undefined && page.seq < feed.seq) {
      if (!feed.valid) {
        throw new Error('Recovery snapshot precedes the committed transcript cursor.')
      }
      return
    }
    for (const descriptor of page.agents) {
      this.#transcript.describeAgent(descriptor)
    }
    const reducer = this.#transcript.ensureAgent(page.agentId)
    const snapshot = prepend && feed !== undefined ? olderSnapshot(page, reducer.snapshot()) : page
    const applied = reducer.receive([{ op: 'reset', agentId: page.agentId, snapshot }])
    if (applied.gap !== undefined) {
      throw new Error('Official transcript reducer rejected a reset.')
    }
    this.#feeds.set(page.agentId, {
      seq: prepend && feed !== undefined ? feed.seq : page.seq,
      valid: prepend && feed !== undefined ? feed.valid : true,
    })
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
