import type { AgentTranscriptSnapshot } from '@poietica/transcript'
import type {
  AgentPromptHandle,
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
  createTimelineState,
  delegateAddress,
  delegateKey,
  projectTranscript,
  selectIsBusy,
} from '../timeline'
import { knownPromptIds, outlineOf, promptOutcome } from '../timeline/transcript-projector'
import { describeFailure } from './describe-failure'
import { TranscriptReplica } from './transcript-replica'
import type { TranscriptSink } from './transcript-sink'

export interface PendingSubmission {
  readonly id: number
  readonly text: string
  readonly submittedAt: number
  readonly phase: 'submitting' | 'accepted' | 'failed'
  readonly promptId: string | null
}

type ConversationOperation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'cancelling' }
  | { readonly kind: 'failed'; readonly message: string; readonly blocks: boolean }

const ACTIVE_STATUSES: readonly RunStatus[] = [
  'submitted',
  'running',
  'cancelling',
  'awaiting_permission',
  'awaiting_question',
]

function activityOf(transcript: Transcript): RunStatus {
  const busy = selectIsBusy(transcript.timeline)
  if (busy && transcript.operation.kind === 'cancelling') {
    return 'cancelling'
  }
  if (busy) {
    return transcript.timeline.status
  }
  if (transcript.submissions.some((entry) => entry.phase !== 'failed')) {
    return 'submitted'
  }
  if (transcript.operation.kind === 'failed' && transcript.operation.blocks) {
    return 'failed'
  }
  return transcript.timeline.status
}

export interface Transcript {
  readonly status: RunStatus
  readonly operation: ConversationOperation
  readonly submissions: readonly PendingSubmission[]
  readonly promptId: string | null
  readonly timeline: TimelineState
  readonly restoring: boolean
  readonly loaded: boolean
  readonly owned: boolean
  readonly earlier: string | null
  readonly outline: readonly TurnMark[]
  readonly reading: boolean
  readonly revealing: string | null
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
const MAIN_AGENT_ID = 'main'
const PENDING_SIGNAL_LIMIT = 64
const EMPTY: Transcript = {
  timeline: createTimelineState(),
  status: 'idle',
  operation: { kind: 'ready' },
  submissions: [],
  promptId: null,
  restoring: false,
  loaded: false,
  owned: false,
  earlier: null,
  outline: [],
  reading: false,
  revealing: null,
}
const channelKey = (threadId: string, agentId: string): string =>
  agentId === MAIN_AGENT_ID ? threadId : delegateKey(threadId, agentId)
const addressOf = (key: string): { readonly conversation: string; readonly agentId: string } =>
  delegateAddress(key) ?? { conversation: key, agentId: MAIN_AGENT_ID }

export class TranscriptStore implements TranscriptSink {
  readonly #held = new Map<string, Transcript>()
  readonly #owners = new Map<string, TranscriptReplica>()
  readonly #routes = new Map<string, string>()
  readonly #pending = new Map<string, TranscriptSignal[]>()
  readonly #lifetimes = new Map<string, AbortController>()
  readonly #listeners = new Map<string, Set<() => void>>()
  readonly #runningListeners = new Set<() => void>()
  readonly #now: () => number
  #running = new Set<string>()
  #port: AgentSessionPort | null = null
  #off: (() => void) | null = null
  #disposed = false
  #serial = 0

  constructor({ now = Date.now }: { readonly now?: () => number } = {}) {
    this.#now = now
  }

  read = (key: string): Transcript => this.#held.get(key) ?? EMPTY
  subscribe = (key: string, listener: () => void): (() => void) => {
    const listeners = this.#listeners.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    this.#listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.#listeners.delete(key)
      }
    }
  }
  runningSnapshot = (): ReadonlySet<string> => this.#running
  subscribeRunning = (listener: () => void): (() => void) => {
    this.#runningListeners.add(listener)
    return () => this.#runningListeners.delete(listener)
  }

  waitForTerminal = (
    key: string,
    promptId: string,
    cancellation?: AbortSignal,
  ): Promise<'completed' | 'cancelled' | 'failed'> => {
    if (promptId.length === 0) {
      return Promise.reject(new Error('A terminal waiter requires an acknowledged prompt ID.'))
    }
    const address = addressOf(key)
    const owned = this.#lifetime(address.conversation).signal
    const signal = cancellation === undefined ? owned : AbortSignal.any([owned, cancellation])
    signal.throwIfAborted()
    const read = () => {
      const snapshot = this.#owners.get(address.conversation)?.snapshot(address.agentId)
      return snapshot === undefined ? null : promptOutcome(snapshot, promptId)
    }
    const immediate = read()
    if (immediate !== null) {
      return Promise.resolve(immediate)
    }
    return new Promise((resolve, reject) => {
      let off: () => void = () => undefined
      const aborted = (): void => {
        off()
        signal.removeEventListener('abort', aborted)
        reject(signal.reason)
      }
      const inspect = (): void => {
        const outcome = read()
        if (outcome !== null) {
          off()
          signal.removeEventListener('abort', aborted)
          resolve(outcome)
        }
      }
      off = this.subscribe(key, inspect)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) {
        aborted()
      } else {
        inspect()
      }
    })
  }

  ensure = (port: AgentSessionPort): void => {
    if (this.#disposed) {
      throw new Error('TranscriptStore is disposed.')
    }
    if (this.#port === port) {
      return
    }
    if (this.#port !== null) {
      throw new Error('A transcript store cannot change its session port.')
    }
    this.#off = port.transcript.subscribeTranscript((signal) => this.#accept(signal))
    this.#port = port
  }

  dispose = (): void => {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    try {
      this.#off?.()
    } finally {
      this.#off = null
      this.#port = null
      for (const lifetime of this.#lifetimes.values()) {
        lifetime.abort(new DOMException('Conversation runtime stopped.', 'AbortError'))
      }
      for (const owner of this.#owners.values()) {
        owner.dispose()
      }
      this.#lifetimes.clear()
      this.#owners.clear()
      this.#routes.clear()
      this.#pending.clear()
      this.#held.clear()
      this.#listeners.clear()
      this.#running = new Set()
      this.#runningListeners.clear()
    }
  }

  route = (sessionId: string, threadId: string, baseline: TranscriptPage): void => {
    const owner = this.#bind(sessionId, threadId)
    owner.seed(baseline)
    this.#flush(sessionId)
    this.#observe(threadId, owner, owner.synchronize(MAIN_AGENT_ID))
  }
  ownerOf = (sessionId: string): string | undefined => this.#routes.get(sessionId)
  opening = (threadId: string): void => {
    this.#lifetime(threadId)
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
  failed = (key: string, cause: unknown, endsTurn = false): void => {
    this.#put(key, {
      ...this.read(key),
      restoring: false,
      operation: { kind: 'failed', message: describeFailure(cause), blocks: endsTurn },
    })
  }
  forget = (threadId: string): void => {
    this.#lifetimes.get(threadId)?.abort(new DOMException('Conversation released.', 'AbortError'))
    this.#lifetimes.delete(threadId)
    const owner = this.#owners.get(threadId)
    owner?.dispose()
    this.#owners.delete(threadId)
    if (owner !== undefined) {
      this.#routes.delete(owner.sessionId)
      this.#pending.delete(owner.sessionId)
    }
    for (const key of this.#held.keys()) {
      if (addressOf(key).conversation === threadId) {
        this.#held.delete(key)
        this.#fire(key)
      }
    }
    this.#publishRunning()
  }

  readEarlier = async (key: string): Promise<void> => {
    const address = addressOf(key)
    const owner = this.#owners.get(address.conversation)
    const current = this.read(key)
    if (owner === undefined || current.earlier === null || current.reading) {
      return
    }
    this.#put(key, { ...current, reading: true })
    try {
      await owner.readEarlier(address.agentId, current.earlier)
    } catch (cause) {
      if (this.#owners.get(address.conversation) === owner) {
        this.failed(key, cause)
        throw cause
      }
    } finally {
      if (this.#owners.get(address.conversation) === owner) {
        this.#put(key, { ...this.read(key), reading: false, revealing: null })
      }
    }
  }
  revealTurn = async (key: string, mark: TurnMark): Promise<void> => {
    while (!this.read(key).outline.some((item) => item.turnId === mark.turnId)) {
      const before = this.read(key).earlier
      if (before === null || this.read(key).reading) {
        return
      }
      await this.readEarlier(key)
      if (this.read(key).earlier === before) {
        throw new Error('Transcript pagination did not advance.')
      }
    }
  }

  send = async ({
    assets,
    configuration,
    onUserMessage,
    port,
    prepare,
    skills,
    text,
    threadId,
  }: SendOptions): Promise<AgentPromptHandle | null> => {
    const lifetime = this.#lifetime(threadId)
    const submission: PendingSubmission = {
      id: this.#serial++,
      text,
      submittedAt: this.#now(),
      phase: 'submitting',
      promptId: null,
    }
    this.#put(threadId, {
      ...this.read(threadId),
      operation: { kind: 'ready' },
      promptId: null,
      submissions: [...this.read(threadId).submissions, submission],
    })
    try {
      if (port === undefined) {
        throw new Error('这个界面还没有接上助手会话。')
      }
      this.ensure(port)
      const ready = await (prepare?.() ?? Promise.resolve(true))
      if (lifetime.signal.aborted) {
        return null
      }
      if (!ready) {
        throw new Error('无法开始新的对话。')
      }
      onUserMessage?.(threadId, text)
      const handle = await port.prompt({ threadId, text, assets, configuration, skills })
      if (lifetime.signal.aborted) {
        return null
      }
      if (handle.promptId.length === 0) {
        throw new Error('代理返回了没有提交身份的收据；请先核对会话，不要重复发送。')
      }
      const owner = this.#bind(handle.sessionId, threadId)
      const current = this.read(threadId)
      const remaining = current.submissions.filter((entry) => entry.id !== submission.id)
      const snapshot = owner.snapshot(MAIN_AGENT_ID)
      const visible = snapshot !== undefined && knownPromptIds(snapshot).has(handle.promptId)
      const accepted: PendingSubmission = {
        ...submission,
        phase: 'accepted',
        promptId: handle.promptId,
      }
      this.#put(threadId, {
        ...current,
        promptId: handle.promptId,
        submissions: visible ? remaining : [...remaining, accepted],
      })
      this.#flush(handle.sessionId)
      this.#observe(threadId, owner, owner.synchronize(MAIN_AGENT_ID))
      return handle
    } catch (cause) {
      if (!lifetime.signal.aborted) {
        const current = this.read(threadId)
        this.#put(threadId, {
          ...current,
          restoring: false,
          operation: { kind: 'failed', message: describeFailure(cause), blocks: true },
          submissions: current.submissions.map(
            (entry): PendingSubmission =>
              entry.id === submission.id ? { ...entry, phase: 'failed' } : entry,
          ),
        })
      }
      return null
    }
  }

  cancel = (key: string): void => {
    const port = this.#port
    const current = this.read(key)
    if (port === null || current.operation.kind === 'cancelling') {
      return
    }
    if (!selectIsBusy(current.timeline)) {
      if (current.submissions.some((entry) => entry.phase !== 'failed')) {
        this.note(key, '消息仍在提交；确认接收后才能停止运行。')
      }
      return
    }
    const thread = addressOf(key).conversation
    const lifetime = this.#lifetime(thread)
    this.#put(key, { ...current, operation: { kind: 'cancelling' } })
    void port.cancel(thread).catch((cause: unknown) => {
      if (!lifetime.signal.aborted) {
        this.failed(key, cause)
      }
    })
  }
  resolvePermission = (key: string, requestId: string, answer: ApprovalAnswer): void => {
    const lifetime = this.#lifetime(addressOf(key).conversation)
    const port = this.#port
    if (port === null) {
      this.note(key, '这个界面还没有接上助手会话。')
      return
    }
    void port.resolvePermission(requestId, answer).catch((cause: unknown) => {
      if (!lifetime.signal.aborted) {
        this.note(key, describeFailure(cause))
      }
    })
  }
  note = (key: string, message: string): void => {
    this.failed(key, new Error(message))
  }

  #lifetime(thread: string): AbortController {
    if (this.#disposed) {
      throw new Error('TranscriptStore is disposed.')
    }
    const held = this.#lifetimes.get(thread)
    if (held !== undefined) {
      return held
    }
    const created = new AbortController()
    this.#lifetimes.set(thread, created)
    return created
  }
  #bind(sessionId: string, thread: string): TranscriptReplica {
    const previous = this.#owners.get(thread)
    if (previous?.sessionId === sessionId) {
      return previous
    }
    if (this.#port === null || this.#disposed) {
      throw new Error('TranscriptStore has no active session port.')
    }
    const claimant = this.#routes.get(sessionId)
    if (claimant !== undefined && claimant !== thread) {
      throw new Error('A transcript session already belongs to another conversation.')
    }
    if (previous !== undefined) {
      this.forget(thread)
    }
    this.#lifetime(thread)
    const owner: TranscriptReplica = new TranscriptReplica(
      sessionId,
      this.#port.transcript,
      (agentId, snapshot) => {
        if (this.#owners.get(thread) === owner) {
          this.#publish(thread, agentId, snapshot)
        }
      },
    )
    this.#owners.set(thread, owner)
    this.#routes.set(sessionId, thread)
    return owner
  }
  #accept(signal: TranscriptSignal): void {
    if (this.#disposed) {
      return
    }
    const thread = this.#routes.get(signal.sessionId)
    const owner = thread === undefined ? undefined : this.#owners.get(thread)
    if (thread !== undefined && owner !== undefined) {
      this.#observe(
        signal.kind === 'ops' ? channelKey(thread, signal.agentId) : thread,
        owner,
        owner.receive(signal),
      )
      return
    }
    const pending = this.#pending.get(signal.sessionId) ?? []
    if (pending.some((item) => item.kind === 'resync')) {
      return
    }
    if (!this.#pending.has(signal.sessionId) && this.#pending.size >= PENDING_SIGNAL_LIMIT) {
      const oldest = this.#pending.keys().next().value
      if (oldest !== undefined) {
        this.#pending.delete(oldest)
      }
    }
    this.#pending.set(
      signal.sessionId,
      signal.kind === 'resync' || pending.length >= PENDING_SIGNAL_LIMIT
        ? [{ kind: 'resync', sessionId: signal.sessionId, reason: 'transcript recovery required' }]
        : [...pending, signal],
    )
  }
  #flush(sessionId: string): void {
    const pending = this.#pending.get(sessionId) ?? []
    this.#pending.delete(sessionId)
    for (const signal of pending) {
      this.#accept(signal)
    }
  }
  #observe(key: string, owner: TranscriptReplica, work: Promise<void>): void {
    void work.catch((cause: unknown) => {
      if (this.#owners.get(addressOf(key).conversation) === owner) {
        this.failed(key, cause)
      }
    })
  }
  #publish(thread: string, agentId: string, snapshot: AgentTranscriptSnapshot): void {
    const key = channelKey(thread, agentId)
    const current = this.read(key)
    const turns = snapshot.items.filter((item) => item.kind === 'turn')
    const timeline = projectTranscript(snapshot)
    const known = knownPromptIds(snapshot)
    const remaining = current.submissions.filter(
      (entry) => entry.promptId === null || !known.has(entry.promptId),
    )
    this.#put(key, {
      ...current,
      timeline,
      restoring: false,
      loaded: true,
      owned: true,
      earlier: snapshot.hasMoreOlder ? (turns[0]?.turnId ?? null) : null,
      outline: outlineOf(snapshot),
      operation:
        current.operation.kind === 'cancelling' && !selectIsBusy(timeline)
          ? { kind: 'ready' }
          : current.operation,
      submissions:
        remaining.length === current.submissions.length ? current.submissions : remaining,
    })
  }
  #put(key: string, next: Transcript): void {
    if (this.#disposed || this.#held.get(key) === next) {
      return
    }
    this.#held.set(key, { ...next, status: activityOf(next) })
    this.#publishRunning()
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
      if (ACTIVE_STATUSES.includes(value.status)) {
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
