import { AgentTranscript, type AgentTranscriptSnapshot } from '@poietica/transcript'
import type {
  AgentSessionPort,
  ApprovalAnswer,
  PromptAsset,
  PromptConfiguration,
  PromptSkill,
  RunStatus,
  ThreadHistory,
  TranscriptPage,
  TranscriptSignal,
  TurnMark,
} from '../agent'
import type { TimelineState } from '../timeline'
import {
  appendLocalError,
  appendUserMessage,
  createTimelineState,
  projectTranscript,
  rejectRunCancellation,
  requestRunCancellation,
  selectIsBusy,
} from '../timeline'
import { describeFailure } from './describe-failure'
import type { TranscriptSink } from './transcript-sink'

export interface Transcript {
  readonly timeline: TimelineState
  readonly restoring: boolean
  readonly loaded: boolean
  readonly owned: boolean
  readonly earlier: string | null
  readonly outline: readonly TurnMark[]
  readonly reading: boolean
  readonly revealing: string | null
}
export interface TranscriptStoreOptions {
  readonly paint?: (flush: () => void) => void
}
export interface SendOptions {
  readonly port: AgentSessionPort | undefined
  readonly threadId: string
  readonly text: string
  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]
  readonly prepare?: (() => Promise<boolean>) | undefined
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
}
interface Owned {
  readonly agent: AgentTranscript
  seq: number
  snapshot: AgentTranscriptSnapshot
  page: TranscriptPage | null
}
const EMPTY: Transcript = {
  timeline: createTimelineState(),
  restoring: false,
  loaded: false,
  owned: false,
  earlier: null,
  outline: [],
  reading: false,
  revealing: null,
}
const terminal = (status: RunStatus): status is 'completed' | 'cancelled' | 'failed' =>
  status === 'completed' || status === 'cancelled' || status === 'failed'
const snapshotOf = (page: TranscriptPage): AgentTranscriptSnapshot => ({
  items: page.items,
  tasks: page.tasks,
  interactions: page.interactions,
  attachments: page.attachments,
  todos: page.todos,
  prompts: page.prompts,
  meta: page.meta,
  hasMoreOlder: page.hasMoreOlder ?? false,
})
const outlineOf = (snapshot: AgentTranscriptSnapshot): readonly TurnMark[] =>
  snapshot.items.flatMap((item) =>
    item.kind === 'turn'
      ? [
          {
            turnId: item.turnId,
            admissionId: item.triggerPromptId ?? item.turnId,
            prompt: item.prompt ?? '',
            reply:
              item.steps
                .flatMap((step) => step.frames)
                .filter((frame) => frame.kind === 'text' && frame.role === 'assistant')
                .map((frame) => frame.text)
                .join('\n\n') || null,
          },
        ]
      : [],
  )

export class TranscriptStore implements TranscriptSink {
  #held = new Map<string, Transcript>()
  #owners = new Map<string, Owned>()
  #routes = new Map<string, string>()
  #listeners = new Map<string, Set<() => void>>()
  #running = new Set<string>()
  #runningListeners = new Set<() => void>()
  #port: AgentSessionPort | null = null
  #off: (() => void) | null = null
  read = (key: string): Transcript => this.#held.get(key) ?? EMPTY
  subscribe = (key: string, listener: () => void): (() => void) => {
    const set = this.#listeners.get(key) ?? new Set()
    set.add(listener)
    this.#listeners.set(key, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) {
        this.#listeners.delete(key)
      }
    }
  }
  runningSnapshot = (): ReadonlySet<string> => this.#running
  subscribeRunning = (listener: () => void): (() => void) => {
    this.#runningListeners.add(listener)
    return () => {
      this.#runningListeners.delete(listener)
    }
  }
  waitForTerminal = (key: string): Promise<'completed' | 'cancelled' | 'failed'> => {
    const now = this.read(key).timeline.status
    if (terminal(now)) {
      return Promise.resolve(now)
    }
    return new Promise((resolve) => {
      const off = this.subscribe(key, () => {
        const status = this.read(key).timeline.status
        if (terminal(status)) {
          off()
          resolve(status)
        }
      })
    })
  }
  ensure = (port: AgentSessionPort): void => {
    if (this.#port === port) {
      return
    }
    this.#off?.()
    this.#port = port
    this.#off = port.transcript.subscribeTranscript((signal) => {
      void this.#signal(signal)
    })
  }
  route = (sessionId: string, threadId: string): void => {
    this.#routes.set(sessionId, threadId)
    void this.#refresh(threadId, sessionId, 'main')
  }
  ownerOf = (sessionId: string): string | undefined => this.#routes.get(sessionId)
  opening = (threadId: string): void => {
    this.#put(threadId, { ...this.read(threadId), restoring: true })
  }
  history = (threadId: string, history: ThreadHistory): void => {
    if (history.state === 'unavailable') {
      this.note(
        threadId,
        history.reason === 'otherAgent'
          ? '这段对话由另一个 agent 保管。'
          : 'agent 已没有这段会话。',
      )
    }
  }
  failed = (threadId: string, cause: unknown): void => {
    const current = this.read(threadId)
    this.#put(threadId, {
      ...current,
      restoring: false,
      timeline: appendLocalError(current.timeline, {
        message: describeFailure(cause),
        at: Date.now(),
        endsTurn: false,
      }),
    })
  }
  forget = (threadId: string): void => {
    this.#held.delete(threadId)
    this.#owners.delete(threadId)
    for (const [session, owner] of this.#routes) {
      if (owner === threadId) {
        this.#routes.delete(session)
      }
    }
    this.#fire(threadId)
    this.#publishRunning()
  }
  readEarlier = async (threadId: string): Promise<void> => {
    const current = this.read(threadId)
    const session = [...this.#routes].find(([, owner]) => owner === threadId)?.[0]
    if (session === undefined || current.earlier === null || this.#port === null) {
      return
    }
    this.#put(threadId, { ...current, reading: true })
    try {
      const page = await this.#port.transcript.readTranscript(session, 'main', current.earlier)
      this.#install(threadId, page, true)
    } finally {
      this.#put(threadId, { ...this.read(threadId), reading: false, revealing: null })
    }
  }
  revealTurn = async (threadId: string, mark: TurnMark): Promise<void> => {
    while (
      this.read(threadId).earlier !== null &&
      !this.read(threadId).outline.some((item) => item.turnId === mark.turnId)
    ) {
      await this.readEarlier(threadId)
    }
  }
  send = ({
    assets,
    configuration,
    onUserMessage,
    port,
    prepare,
    skills,
    text,
    threadId,
  }: SendOptions): void => {
    const current = this.read(threadId)
    this.#put(threadId, {
      ...current,
      timeline: appendUserMessage(
        current.timeline,
        text,
        Date.now(),
        assets.length,
        skills.map((skill) => skill.name),
      ),
    })
    if (port === undefined) {
      this.failed(threadId, new Error('这个界面还没有接上助手会话。'))
      return
    }
    this.ensure(port)
    void (prepare?.() ?? Promise.resolve(true))
      .then(async (ready) => {
        if (!ready) {
          throw new Error('无法开始新的对话。')
        }
        onUserMessage?.(threadId, text)
        const handle = await port.prompt({ threadId, text, assets, configuration, skills })
        this.route(handle.sessionId, threadId)
      })
      .catch((cause: unknown) => this.failed(threadId, cause))
  }
  cancel = (key: string): void => {
    const port = this.#port
    if (port === null || !selectIsBusy(this.read(key).timeline)) {
      return
    }
    const current = this.read(key)
    this.#put(key, { ...current, timeline: requestRunCancellation(current.timeline) })
    void port.cancel(key).catch((cause: unknown) => {
      this.note(key, describeFailure(cause))
      const latest = this.read(key)
      this.#put(key, { ...latest, timeline: rejectRunCancellation(latest.timeline) })
    })
  }
  resolvePermission = (key: string, requestId: string, answer: ApprovalAnswer): void => {
    void this.#port
      ?.resolvePermission(requestId, answer)
      .catch((cause: unknown) => this.note(key, describeFailure(cause)))
  }
  note = (key: string, message: string): void => {
    const current = this.read(key)
    this.#put(key, {
      ...current,
      timeline: appendLocalError(current.timeline, { message, at: Date.now(), endsTurn: false }),
    })
  }
  async #signal(signal: TranscriptSignal): Promise<void> {
    const thread = this.#routes.get(signal.sessionId)
    if (thread === undefined) {
      return
    }
    if (signal.kind === 'resync') {
      await this.#refresh(thread, signal.sessionId, 'main')
      return
    }
    const owned = this.#owners.get(thread)
    if (owned === undefined || signal.seq !== owned.seq + 1 || signal.kind === 'reset') {
      if (signal.kind === 'reset') {
        const page = {
          ...signal.snapshot,
          agentId: signal.agentId,
          agents: [],
          pendingInteractions: [],
          seq: signal.seq,
        } satisfies TranscriptPage
        this.#install(thread, page, false)
        return
      }
      await this.#reconcile(thread, signal.sessionId, signal.agentId)
      return
    }
    const result = owned.agent.receive(signal.ops)
    if (result.gap !== undefined) {
      await this.#refresh(thread, signal.sessionId, signal.agentId)
      return
    }
    owned.seq = signal.seq
    owned.snapshot = owned.agent.snapshot()
    this.#publish(thread, owned)
  }
  async #reconcile(thread: string, session: string, agent: string): Promise<void> {
    const owned = this.#owners.get(thread)
    if (owned === undefined || this.#port === null) {
      await this.#refresh(thread, session, agent)
      return
    }
    const caught = await this.#port.transcript.catchUpTranscript(session, agent, owned.seq)
    if (!caught.complete) {
      await this.#refresh(thread, session, agent)
      return
    }
    for (const batch of caught.batches) {
      if (batch.seq !== owned.seq + 1) {
        await this.#refresh(thread, session, agent)
        return
      }
      const result = owned.agent.receive(batch.ops)
      if (result.gap !== undefined) {
        await this.#refresh(thread, session, agent)
        return
      }
      owned.seq = batch.seq
    }
    owned.snapshot = owned.agent.snapshot()
    this.#publish(thread, owned)
  }
  async #refresh(thread: string, session: string, agent: string): Promise<void> {
    if (this.#port === null) {
      return
    }
    try {
      this.#install(thread, await this.#port.transcript.readTranscript(session, agent), false)
    } catch (cause) {
      this.failed(thread, cause)
    }
  }
  #install(thread: string, page: TranscriptPage, prepend: boolean): void {
    const previous = this.#owners.get(thread)?.agent.snapshot()
    const snapshot =
      prepend && previous !== undefined
        ? { ...snapshotOf(page), items: [...page.items, ...previous.items] }
        : snapshotOf(page)
    const agent = new AgentTranscript(page.agentId)
    const result = agent.receive([{ op: 'reset', agentId: page.agentId, snapshot }])
    if (result.gap !== undefined) {
      throw new Error('official reducer rejected a reset snapshot')
    }
    const owned: Owned = { agent, seq: page.seq, snapshot: agent.snapshot(), page }
    this.#owners.set(thread, owned)
    this.#publish(thread, owned)
  }
  #publish(thread: string, owned: Owned): void {
    const timeline = projectTranscript(owned.snapshot)
    const turns = owned.snapshot.items.filter((item) => item.kind === 'turn')
    this.#put(thread, {
      timeline,
      restoring: false,
      loaded: true,
      owned: true,
      earlier: owned.agent.hasMoreOlder ? (turns[0]?.turnId ?? null) : null,
      outline: outlineOf(owned.snapshot),
      reading: this.read(thread).reading,
      revealing: this.read(thread).revealing,
    })
    this.#publishRunning()
  }
  #put(key: string, next: Transcript): void {
    this.#held.set(key, next)
    this.#fire(key)
  }
  #fire(key: string): void {
    for (const listener of this.#listeners.get(key) ?? []) {
      listener()
    }
  }
  #publishRunning(): void {
    const next = new Set(
      [...this.#held].filter(([, value]) => selectIsBusy(value.timeline)).map(([key]) => key),
    )
    if (next.size === this.#running.size && [...next].every((key) => this.#running.has(key))) {
      return
    }
    this.#running = next
    for (const listener of this.#runningListeners) {
      listener()
    }
  }
}
