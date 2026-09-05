import {
  type AgentTranscriptSnapshot,
  TranscriptStore as OfficialTranscriptStore,
} from '@poietica/transcript'
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
  delegateAddress,
  delegateKey,
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
interface AgentFeed {
  seq: number
  page: TranscriptPage | null
}
interface OwnedSession {
  readonly sessionId: string
  readonly transcript: OfficialTranscriptStore
  readonly feeds: Map<string, AgentFeed>
}
const MAIN_AGENT_ID = 'main'
const PENDING_SIGNAL_LIMIT = 64
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
const channelKey = (threadId: string, agentId: string): string =>
  agentId === MAIN_AGENT_ID ? threadId : delegateKey(threadId, agentId)
const addressOf = (key: string): { readonly conversation: string; readonly agentId: string } =>
  delegateAddress(key) ?? { conversation: key, agentId: MAIN_AGENT_ID }

export class TranscriptStore implements TranscriptSink {
  #held = new Map<string, Transcript>()
  #owners = new Map<string, OwnedSession>()
  #routes = new Map<string, string>()
  #pending = new Map<string, TranscriptSignal[]>()
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
    return () => this.#runningListeners.delete(listener)
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
    this.#off = port.transcript.subscribeTranscript((signal) => this.#accept(signal))
  }
  route = (sessionId: string, threadId: string, baseline: TranscriptPage): void => {
    this.#bind(sessionId, threadId)
    this.#install(threadId, sessionId, baseline, false)
    const pending = this.#pending.get(sessionId) ?? []
    this.#pending.delete(sessionId)
    for (const signal of pending) {
      this.#accept(signal)
    }
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
  failed = (key: string, cause: unknown): void => {
    const current = this.read(key)
    this.#put(key, {
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
    const keys = [...this.#held.keys()].filter(
      (key) => key === threadId || delegateAddress(key)?.conversation === threadId,
    )
    for (const key of keys) {
      this.#held.delete(key)
      this.#fire(key)
    }
    this.#owners.delete(threadId)
    for (const [session, owner] of this.#routes) {
      if (owner === threadId) {
        this.#routes.delete(session)
        this.#pending.delete(session)
      }
    }
    this.#publishRunning()
  }
  readEarlier = async (key: string): Promise<void> => {
    const address = addressOf(key)
    const current = this.read(key)
    const session = this.#sessionFor(address.conversation)
    if (session === undefined || current.earlier === null || this.#port === null) {
      return
    }
    this.#put(key, { ...current, reading: true })
    try {
      const page = await this.#port.transcript.readTranscript(
        session,
        address.agentId,
        current.earlier,
      )
      this.#install(address.conversation, session, page, true)
    } finally {
      this.#put(key, { ...this.read(key), reading: false, revealing: null })
    }
  }
  revealTurn = async (key: string, mark: TurnMark): Promise<void> => {
    while (
      this.read(key).earlier !== null &&
      !this.read(key).outline.some((item) => item.turnId === mark.turnId)
    ) {
      await this.readEarlier(key)
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
        this.#bind(handle.sessionId, threadId)
        if (!this.read(threadId).loaded) {
          void this.#refresh(threadId, handle.sessionId, MAIN_AGENT_ID)
        }
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
    const threadId = addressOf(key).conversation
    void port.cancel(threadId).catch((cause: unknown) => {
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

  #accept(signal: TranscriptSignal): void {
    if (this.#routes.has(signal.sessionId)) {
      void this.#signal(signal)
      return
    }
    const pending = this.#pending.get(signal.sessionId) ?? []
    if (pending.some((item) => item.kind === 'resync')) {
      return
    }
    if (signal.kind === 'resync' || pending.length >= PENDING_SIGNAL_LIMIT) {
      this.#pending.set(signal.sessionId, [
        {
          kind: 'resync',
          sessionId: signal.sessionId,
          reason: signal.kind === 'resync' ? signal.reason : 'pending transcript buffer overflow',
        },
      ])
      return
    }
    this.#pending.set(signal.sessionId, [...pending, signal])
  }
  #bind(sessionId: string, threadId: string): void {
    this.#routes.set(sessionId, threadId)
    this.#owner(threadId, sessionId)
  }
  async #signal(signal: TranscriptSignal): Promise<void> {
    const thread = this.#routes.get(signal.sessionId)
    if (thread === undefined) {
      return
    }
    const owner = this.#owner(thread, signal.sessionId)
    if (signal.kind === 'resync') {
      const agents = owner.feeds.size === 0 ? [MAIN_AGENT_ID] : [...owner.feeds.keys()]
      await Promise.all(agents.map((agentId) => this.#refresh(thread, signal.sessionId, agentId)))
      return
    }
    /* Full snapshots enter through route; WS only advances or invalidates them. */
    const feed = owner.feeds.get(signal.agentId)
    if (feed === undefined || signal.seq !== feed.seq + 1) {
      await this.#reconcile(thread, signal.sessionId, signal.agentId)
      return
    }
    const transcript = owner.transcript.ensureAgent(signal.agentId)
    const result = transcript.receive(signal.ops)
    if (result.gap !== undefined) {
      await this.#refresh(thread, signal.sessionId, signal.agentId)
      return
    }
    feed.seq = signal.seq
    this.#publish(thread, signal.agentId, owner, feed)
  }
  async #reconcile(thread: string, session: string, agentId: string): Promise<void> {
    const owner = this.#owner(thread, session)
    const feed = owner.feeds.get(agentId)
    if (feed === undefined || this.#port === null) {
      await this.#refresh(thread, session, agentId)
      return
    }
    const caught = await this.#port.transcript.catchUpTranscript(session, agentId, feed.seq)
    if (!caught.complete || caught.agentId !== agentId) {
      await this.#refresh(thread, session, agentId)
      return
    }
    const transcript = owner.transcript.ensureAgent(agentId)
    for (const batch of caught.batches) {
      if (batch.seq !== feed.seq + 1) {
        await this.#refresh(thread, session, agentId)
        return
      }
      const result = transcript.receive(batch.ops)
      if (result.gap !== undefined) {
        await this.#refresh(thread, session, agentId)
        return
      }
      feed.seq = batch.seq
    }
    this.#publish(thread, agentId, owner, feed)
  }
  async #refresh(thread: string, session: string, agentId: string): Promise<void> {
    if (this.#port === null) {
      return
    }
    const key = channelKey(thread, agentId)
    try {
      const page = await this.#port.transcript.readTranscript(session, agentId)
      if (page.agentId !== agentId) {
        throw new Error('transcript response changed agent identity')
      }
      this.#install(thread, session, page, false)
    } catch (cause) {
      this.failed(key, cause)
    }
  }
  #install(thread: string, session: string, page: TranscriptPage, prepend: boolean): void {
    const owner = this.#owner(thread, session)
    for (const descriptor of page.agents) {
      owner.transcript.describeAgent(descriptor)
    }
    const transcript = owner.transcript.ensureAgent(
      page.agentId,
      owner.transcript.agents().find((agent) => agent.agentId === page.agentId),
    )
    const previous = owner.feeds.has(page.agentId) ? transcript.snapshot() : undefined
    const snapshot =
      prepend && previous !== undefined
        ? {
            ...previous,
            items: [...page.items, ...previous.items],
            hasMoreOlder: page.hasMoreOlder ?? false,
          }
        : snapshotOf(page)
    const result = transcript.receive([{ op: 'reset', agentId: page.agentId, snapshot }])
    if (result.gap !== undefined) {
      throw new Error('official reducer rejected a reset snapshot')
    }
    const feed: AgentFeed = { seq: page.seq, page }
    owner.feeds.set(page.agentId, feed)
    this.#publish(thread, page.agentId, owner, feed)
  }
  #publish(thread: string, agentId: string, owner: OwnedSession, feed: AgentFeed): void {
    const transcript = owner.transcript.getAgent(agentId)
    if (transcript === undefined) {
      throw new Error('official transcript store lost an agent')
    }
    const snapshot = transcript.snapshot()
    const key = channelKey(thread, agentId)
    const current = this.read(key)
    const turns = snapshot.items.filter((item) => item.kind === 'turn')
    this.#put(key, {
      timeline: projectTranscript(snapshot),
      restoring: false,
      loaded: true,
      owned: true,
      earlier: transcript.hasMoreOlder ? (turns[0]?.turnId ?? null) : null,
      outline: outlineOf(snapshot),
      reading: current.reading,
      revealing: current.revealing,
    })
    feed.page = feed.page === null ? null : { ...feed.page, ...snapshot }
    this.#publishRunning()
  }
  #owner(thread: string, session: string): OwnedSession {
    const existing = this.#owners.get(thread)
    if (existing !== undefined && existing.sessionId === session) {
      return existing
    }
    const created: OwnedSession = {
      sessionId: session,
      transcript: new OfficialTranscriptStore(session),
      feeds: new Map(),
    }
    this.#owners.set(thread, created)
    return created
  }
  #sessionFor(thread: string): string | undefined {
    return [...this.#routes].find(([, owner]) => owner === thread)?.[0]
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
    const next = new Set<string>()
    for (const [key, value] of this.#held) {
      if (selectIsBusy(value.timeline)) {
        next.add(addressOf(key).conversation)
      }
    }
    if (next.size === this.#running.size && [...next].every((key) => this.#running.has(key))) {
      return
    }
    this.#running = next
    for (const listener of this.#runningListeners) {
      listener()
    }
  }
}
