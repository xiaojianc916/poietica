import type { OpenedThread, ThreadPort, ThreadRecord } from '../agent'
import { describeFailure } from './describe-failure'
import type { ThreadsList } from './thread-order'
import { NO_ITEMS, ThreadProjection } from './thread-projection'
import { forkNameOf, nameOf, shorten } from './thread-title'
import { normalizeWorkspaceRoot } from './workspace-root'

type Intent =
  | {
      readonly kind: 'activity'
      readonly threadId: string
      readonly title: string
      readonly at: string
    }
  | { readonly kind: 'rename'; readonly threadId: string; readonly title: string }
  | { readonly kind: 'pin'; readonly threadId: string; readonly pinned: boolean }
interface Held {
  readonly records: ReadonlyMap<string, ThreadRecord>
  readonly intents: ReadonlyMap<number, Intent>
  readonly isLoading: boolean
  readonly failure: string | null
}
export interface ThreadsStoreOptions {
  readonly defaultWorkspaceId?: (() => string | null) | undefined
  readonly port?: ThreadPort | undefined
  readonly now?: (() => string) | undefined
}

/** Only port responses enter records; pending user commands are a separate intent log. */
export class ThreadsStore {
  readonly #port: ThreadPort | undefined
  readonly #defaultWorkspaceId: (() => string | null) | undefined
  readonly #now: () => string
  readonly #projection = new ThreadProjection()
  readonly #archivedProjection = new ThreadProjection()
  readonly #listeners = new Set<() => void>()
  readonly #removed = new Set<(threadId: string) => void>()
  readonly #opened = new Set<(answer: OpenedThread) => void>()
  readonly #tails = new Map<string, Promise<void>>()
  #held: Held = { records: new Map(), intents: new Map(), isLoading: true, failure: null }
  #visible: ReadonlyMap<string, ThreadRecord> = new Map()
  #list: ThreadsList = { items: NO_ITEMS, isLoading: true, failure: null }
  #archived: ThreadsList = { items: NO_ITEMS, isLoading: true, failure: null }
  #disposed = false
  #revision = 0
  #nextIntent = 0
  #refreshing: Promise<void> | null = null
  #refreshAgain = false

  constructor({ defaultWorkspaceId, port, now }: ThreadsStoreOptions) {
    this.#port = port
    this.#defaultWorkspaceId = defaultWorkspaceId
    this.#now = now ?? (() => new Date().toISOString())
  }
  dispose = (): void => {
    this.#disposed = true
    this.#revision += 1
    this.#listeners.clear()
    this.#removed.clear()
    this.#opened.clear()
    this.#tails.clear()
  }
  subscribe = (listener: () => void): (() => void) => {
    if (!this.#disposed) {
      this.#listeners.add(listener)
    }
    return () => {
      this.#listeners.delete(listener)
    }
  }
  onRemoved = (listener: (threadId: string) => void): (() => void) => {
    if (!this.#disposed) {
      this.#removed.add(listener)
    }
    return () => {
      this.#removed.delete(listener)
    }
  }
  onOpened = (listener: (answer: OpenedThread) => void): (() => void) => {
    if (!this.#disposed) {
      this.#opened.add(listener)
    }
    return () => {
      this.#opened.delete(listener)
    }
  }
  listSnapshot = (): ThreadsList => this.#list
  archivedSnapshot = (): ThreadsList => this.#archived
  rootOf = (threadId: string): string | null => {
    const root = this.#held.records.get(threadId)?.workspaceRoot
    return root == null || root.length === 0 ? null : normalizeWorkspaceRoot(root)
  }
  titleOf = (threadId: string): string => nameOf(this.#visible.get(threadId))
  standInTitle = (message: string): string => shorten(message) || '[图片]'

  refresh = (): Promise<void> => {
    if (this.#disposed) {
      return Promise.resolve()
    }
    if (this.#refreshing !== null) {
      this.#refreshAgain = true
      return this.#refreshing
    }
    const port = this.#port
    if (port === undefined) {
      this.#commit({ isLoading: false })
      return Promise.resolve()
    }
    const work = async (): Promise<void> => {
      do {
        this.#refreshAgain = false
        const revision = this.#revision
        try {
          const found = await port.list()
          if (this.#disposed) {
            return
          }
          if (revision !== this.#revision) {
            this.#refreshAgain = true
            continue
          }
          const records = new Map(
            [...this.#held.records].filter(([, record]) => record.titleSource === 'fallback'),
          )
          const seen = new Set<string>()
          for (const record of found) {
            if (seen.has(record.threadId)) {
              throw new Error('The platform returned duplicate conversation identities.')
            }
            seen.add(record.threadId)
            records.set(record.threadId, record)
          }
          this.#commit({
            records,
            intents: this.#confirmed(this.#held.intents, records),
            isLoading: false,
            failure: null,
          })
        } catch (reason) {
          if (this.#disposed) {
            return
          }
          if (revision !== this.#revision) {
            this.#refreshAgain = true
            continue
          }
          this.#commit({ isLoading: false, failure: describeFailure(reason) })
        }
      } while (this.#refreshAgain && !this.#disposed)
    }
    const running = work().finally(() => {
      if (this.#refreshing === running) {
        this.#refreshing = null
      }
    })
    this.#refreshing = running
    return running
  }

  create = (threadId: string, workspaceRoot?: string): Promise<string | null> =>
    this.#serial(threadId, async () => {
      if (this.#disposed || this.#port === undefined) {
        return null
      }
      this.#revision += 1
      const opened = await this.#port.create(threadId, workspaceRoot)
      if (this.#disposed) {
        return null
      }
      this.#identity(threadId, opened.thread)
      const records = new Map(this.#held.records).set(threadId, opened.thread)
      this.#commit({ records, failure: null })
      for (const listener of this.#opened) {
        listener(opened)
      }
      return threadId
    })

  noteUserMessage = (threadId: string, message: string): void => {
    if (this.#disposed) {
      return
    }
    const intents = new Map(this.#held.intents)
    let title = this.standInTitle(message)
    for (const [key, intent] of intents) {
      if (intent.threadId === threadId && intent.kind === 'activity') {
        title = intent.title
        intents.delete(key)
      }
    }
    intents.set(++this.#nextIntent, { kind: 'activity', threadId, title, at: this.#now() })
    this.#commit({ intents })
  }
  rename = (threadId: string, title: string): Promise<void> => {
    const action = this.#port?.rename
    const named = title.trim()
    if (this.#disposed || action === undefined || named.length === 0) {
      return Promise.resolve()
    }
    return this.#change(threadId, () => action(threadId, named), {
      kind: 'rename',
      threadId,
      title: named,
    })
  }
  setPinned = (threadId: string, pinned: boolean): Promise<void> => {
    const action = this.#port?.setPinned
    if (this.#disposed || action === undefined) {
      return Promise.resolve()
    }
    return this.#change(threadId, () => action(threadId, pinned), { kind: 'pin', threadId, pinned })
  }
  archive = (threadId: string, archived: boolean): Promise<void> => {
    const action = this.#port?.archive
    if (this.#disposed || action === undefined) {
      return Promise.resolve()
    }
    return this.#change(threadId, () => action(threadId, archived), undefined, archived)
  }
  remove = (threadId: string): Promise<void> =>
    this.#serial(threadId, async () => {
      const action = this.#port?.remove
      if (this.#disposed || action === undefined) {
        return
      }
      this.#revision += 1
      try {
        await action(threadId)
      } catch (reason) {
        this.#revision += 1
        this.#commit({ failure: describeFailure(reason) })
        return
      }
      if (this.#disposed) {
        return
      }
      const records = new Map(this.#held.records)
      records.delete(threadId)
      const intents = new Map(
        [...this.#held.intents].filter(([, intent]) => intent.threadId !== threadId),
      )
      this.#commit({ records, intents, failure: null })
      for (const listener of this.#removed) {
        listener(threadId)
      }
    })
  fork = (threadId: string, dropTurns: number): Promise<string | null> =>
    this.#serial(threadId, async () => {
      const action = this.#port?.fork
      if (this.#disposed || action === undefined) {
        return null
      }
      this.#revision += 1
      try {
        const forked = await action(threadId, forkNameOf(this.titleOf(threadId)), dropTurns)
        if (this.#disposed) {
          return null
        }
        if (forked.threadId === threadId) {
          throw new Error('A fork must have a distinct conversation identity.')
        }
        this.#commit({
          records: new Map(this.#held.records).set(forked.threadId, forked),
          failure: null,
        })
        await this.refresh()
        return this.#disposed ? null : forked.threadId
      } catch (reason) {
        this.#revision += 1
        this.#commit({ failure: describeFailure(reason) })
        return null
      }
    })
  export = async (threadId: string): Promise<boolean> => {
    const action = this.#port?.export
    if (this.#disposed || action === undefined) {
      return false
    }
    try {
      const saved = await action(threadId)
      if (this.#disposed) {
        return false
      }
      this.#commit({ failure: null })
      return saved
    } catch (reason) {
      this.#commit({ failure: describeFailure(reason) })
      return false
    }
  }

  #serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(threadId) ?? Promise.resolve()
    const result = previous.then(work)
    // The returned result retains failure; this tail only orders subsequent commands.
    const tail = result.then(
      () => {},
      () => {},
    )
    this.#tails.set(threadId, tail)
    void tail.then(() => {
      if (this.#tails.get(threadId) === tail) {
        this.#tails.delete(threadId)
      }
    })
    return result
  }
  #change(
    threadId: string,
    action: () => Promise<void>,
    intent?: Intent,
    closeTab = false,
  ): Promise<void> {
    const key = ++this.#nextIntent
    if (intent !== undefined) {
      this.#commit({ intents: new Map(this.#held.intents).set(key, intent) })
    }
    return this.#serial(threadId, async () => {
      if (this.#disposed || this.#port === undefined) {
        return
      }
      this.#revision += 1
      try {
        await action()
      } catch (reason) {
        this.#revision += 1
        const intents = new Map(this.#held.intents)
        intents.delete(key)
        this.#commit({ intents })
        await this.refresh()
        this.#commit({ failure: describeFailure(reason) })
        return
      }
      if (this.#disposed) {
        return
      }
      this.#revision += 1
      try {
        const snapshot = await this.#port.read(threadId)
        if (this.#disposed) {
          return
        }
        this.#identity(threadId, snapshot.thread)
        const records = new Map(this.#held.records).set(threadId, snapshot.thread)
        const intents = new Map(this.#held.intents)
        intents.delete(key)
        this.#commit({ records, intents: this.#confirmed(intents, records), failure: null })
      } catch (reason) {
        this.#revision += 1
        const intents = new Map(this.#held.intents)
        intents.delete(key)
        this.#commit({ intents })
        await this.refresh()
        this.#commit({ failure: describeFailure(reason) })
      }
      if (closeTab && !this.#disposed) {
        for (const listener of this.#removed) {
          listener(threadId)
        }
      }
    })
  }
  #identity(expected: string, record: ThreadRecord): void {
    if (record.threadId !== expected) {
      throw new Error('The platform returned a different conversation identity.')
    }
  }
  #confirmed(
    intents: ReadonlyMap<number, Intent>,
    records: ReadonlyMap<string, ThreadRecord>,
  ): ReadonlyMap<number, Intent> {
    const remaining = new Map(intents)
    for (const [key, intent] of remaining) {
      if (intent.kind !== 'activity') {
        continue
      }
      const record = records.get(intent.threadId)
      if (
        record !== undefined &&
        record.titleSource !== 'fallback' &&
        Date.parse(record.updatedAt) >= Date.parse(intent.at)
      ) {
        remaining.delete(key)
      }
    }
    return remaining
  }
  #project(next: Held): ReadonlyMap<string, ThreadRecord> {
    const visible = new Map(next.records)
    for (const intent of next.intents.values()) {
      const record = visible.get(intent.threadId)
      if (intent.kind === 'activity') {
        if (record === undefined) {
          visible.set(intent.threadId, {
            threadId: intent.threadId,
            sessionId: null,
            title: intent.title,
            titleSource: 'message',
            updatedAt: intent.at,
          })
        } else {
          visible.set(intent.threadId, {
            ...record,
            ...(record.titleSource === 'fallback'
              ? { title: intent.title, titleSource: 'message' as const }
              : {}),
            updatedAt:
              Date.parse(intent.at) > Date.parse(record.updatedAt) ? intent.at : record.updatedAt,
          })
        }
      } else if (record !== undefined) {
        visible.set(
          intent.threadId,
          intent.kind === 'rename'
            ? { ...record, title: intent.title, titleSource: 'manual' }
            : { ...record, pinned: intent.pinned },
        )
      }
    }
    return visible
  }
  #commit(patch: Partial<Held>): void {
    if (this.#disposed) {
      return
    }
    const next = { ...this.#held, ...patch }
    const listing = next.records !== this.#held.records || next.intents !== this.#held.intents
    this.#held = next
    if (listing) {
      this.#revision += 1
      this.#visible = this.#project(next)
    }
    const workspace = this.#defaultWorkspaceId?.() ?? undefined
    const rows = [...this.#visible.values()].filter((record) => record.titleSource !== 'fallback')
    const active = listing
      ? this.#projection.of(
          rows.filter((row) => row.archived !== true),
          workspace,
        )
      : this.#list.items
    const archived = listing
      ? this.#archivedProjection.of(
          rows.filter((row) => row.archived === true),
          workspace,
        )
      : this.#archived.items
    const previous = this.#list
    const previousArchived = this.#archived
    const { isLoading, failure } = next
    if (
      active !== previous.items ||
      isLoading !== previous.isLoading ||
      failure !== previous.failure
    ) {
      this.#list = { items: active, isLoading, failure }
    }
    if (
      archived !== previousArchived.items ||
      isLoading !== previousArchived.isLoading ||
      failure !== previousArchived.failure
    ) {
      this.#archived = { items: archived, isLoading, failure }
    }
    if (previous !== this.#list || previousArchived !== this.#archived) {
      for (const listener of this.#listeners) {
        listener()
      }
    }
  }
}
