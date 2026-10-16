import { InvariantError, invariant } from '@poietica/foundation'
import {
  type TranscriptPage as AgentTranscriptSnapshot,
  applyOps,
  emptyTimeline,
  pageFromState,
  prependOlder,
  type TimelineState,
  TranscriptGapError,
  type TranscriptOperation,
} from '@poietica/transcript'

/* 只需两件事：按 agent 存一份状态、按 op 推进并报告缺口 —— 用 @poietica/transcript 的 applyOps 就地实现。 */
interface ReduceResult {
  readonly accepted: readonly TranscriptOperation[]
  readonly gap?: { readonly expected: number; readonly got: number }
}

class AgentReducer {
  #state: TimelineState | null = null

  snapshot(): AgentTranscriptSnapshot {
    return this.#state === null ? EMPTY_PAGE : pageFromState(this.#state)
  }

  receive(operations: readonly TranscriptOperation[]): ReduceResult {
    if (operations.length === 0) return { accepted: [] }
    try {
      this.#state = applyOps(this.#state ?? emptyTimeline(), operations)
      return { accepted: operations }
    } catch (error) {
      if (error instanceof TranscriptGapError) {
        /* #state 没被赋值 —— 调用方（#apply）依赖这一点，不做回滚 */
        return { accepted: [], gap: { expected: error.expected, got: error.got } }
      }
      throw error
    }
  }
}

const EMPTY_PAGE: AgentTranscriptSnapshot = {
  items: [],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
  hasMoreOlder: false,
} as AgentTranscriptSnapshot

class LocalTranscriptStore {
  readonly #agents = new Map<string, AgentReducer>()
  readonly #roster = new Map<string, { readonly agentId: string; readonly role: string }>()

  agents(): readonly { readonly agentId: string; readonly role: string }[] {
    return [...this.#roster.values()]
  }

  ensureAgent(agentId: string): AgentReducer {
    this.#roster.set(agentId, this.describeAgent({ agentId }))
    let agent = this.#agents.get(agentId)
    if (agent === undefined) {
      agent = new AgentReducer()
      this.#agents.set(agentId, agent)
    }
    return agent
  }

  describeAgent(descriptor: { readonly agentId: string; readonly name?: string | undefined }): {
    readonly agentId: string
    readonly role: string
  } {
    const known = this.#roster.get(descriptor.agentId)
    if (known !== undefined) return known
    const entry = { agentId: descriptor.agentId, role: descriptor.agentId === 'main' ? 'main' : 'child' }
    this.#roster.set(descriptor.agentId, entry)
    return entry
  }

  getAgent(agentId: string): AgentReducer | undefined {
    return this.#agents.get(agentId)
  }
}

import type { TranscriptCatchUp, TranscriptPage, TranscriptPort, TranscriptSignal } from '../../shared/model/transcript'

type Feed = { seq: number; valid: boolean; tail: Promise<void> }
type Publish = (agentId: string, snapshot: AgentTranscriptSnapshot) => void

/** 合并连续的补齐批次；任何缺口都清掉 complete 并停止合并。 */
function foldCatchUp(
  caught: TranscriptCatchUp,
  from: number,
): { complete: boolean; cursor: number; operations: TranscriptOperation[] } {
  let cursor = from
  const operations: TranscriptOperation[] = []
  let complete = caught.complete
  if (complete) {
    for (const batch of caught.batches) {
      if (!Number.isSafeInteger(batch.seq) || batch.seq < 0) {
        invariant(false, 'Transcript batch has an invalid sequence.')
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
  return { complete, cursor, operations }
}

/** 一个会话持有自己的 reducer 与按序的恢复工作；它不持有任何界面状态。 */
export class TranscriptReplica {
  readonly #transcript: LocalTranscriptStore
  readonly #port: TranscriptPort
  readonly #publish: Publish
  readonly #feeds = new Map<string, Feed>()
  #disposed = false

  readonly sessionId: string

  constructor(sessionId: string, port: TranscriptPort, publish: Publish) {
    this.sessionId = sessionId
    this.#transcript = new LocalTranscriptStore()
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
    // 开场答复不能顶掉正在恢复的那一份基线。
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
      return Promise.reject(new InvariantError('Transcript signal changed session identity.'))
    }
    if (signal.kind === 'resync') {
      return this.#resync()
    }
    if (signal.kind === 'reset') {
      return this.#restart(signal.agentId, signal.seq)
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
      const page = await this.#read(agentId, feed, () => this.#port.readTranscript(this.sessionId, agentId, beforeTurn))
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

  /**
   * 退掉这个 agent 的这一代并重建。`watermark` 是 server 在 reset 里自报的当前水位；它正好等于我们手上那一页时，那截尾巴我们已经有了 —— 再整读只是白花一次往返。
   * 换掉 feed 对象这一步不省：它是这一代的身份，在飞的老读法必须作废。
   */
  #restart(agentId: string, watermark?: number): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve()
    }
    const held = this.#feeds.get(agentId)
    const arrived = watermark !== undefined && held?.valid === true && watermark === held.seq
    this.#feeds.delete(agentId)
    if (!arrived) {
      return this.refresh(agentId)
    }
    const generation = this.#feed(agentId)
    generation.seq = watermark
    generation.valid = true
    return Promise.resolve()
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
      // 只有持有这一代的调用方才看得到 I/O 失败。
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
    // 拒绝由调用方持有，含后继恢复失败的情形。
    feed.tail = work.then(
      () => undefined,
      () => undefined,
    )
    return work
  }

  async #advance(signal: Extract<TranscriptSignal, { kind: 'ops' }>, feed: Feed): Promise<void> {
    if (!Number.isSafeInteger(signal.seq) || signal.seq < 0) {
      invariant(false, 'Transcript event has an invalid sequence.')
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
      invariant(false, 'Transcript catch-up changed agent identity.')
    }
    if (!Number.isSafeInteger(caught.latestSeq) || caught.latestSeq < 0) {
      invariant(false, 'Transcript catch-up has an invalid sequence.')
    }
    if (caught.latestSeq < feed.seq) {
      await this.#restart(agentId)
      return
    }
    const folded = foldCatchUp(caught, feed.seq)
    /*
     * 判据是「我们到没到 server 的水位」，不是「批次日志连不连续」：complete:false 只说 journal 够不着 since_seq ——
     * 冷会话恒回这一档，而它的 latest_seq 与我们手上那一页的水位本就相等，再整读只是白花一次全文往返。
     */
    if (folded.cursor !== caught.latestSeq) {
      feed.valid = false
      await this.#head(agentId, feed, caught.latestSeq)
      return
    }
    if (!this.#apply(agentId, feed, folded.cursor, folded.operations)) {
      await this.#head(agentId, feed, caught.latestSeq)
    }
  }

  #apply(agentId: string, feed: Feed, seq: number, operations: readonly TranscriptOperation[]): boolean {
    if (operations.length === 0) {
      feed.seq = seq
      return true
    }
    const reducer = this.#transcript.ensureAgent(agentId)
    /* 缺口时不必回滚：applyOps 不修改输入状态、整批作废时 AgentReducer 根本没赋值（TL-5b 钉着这一条）。 */
    const result = reducer.receive(operations)
    if (result.gap !== undefined) {
      feed.valid = false
      return false
    }
    feed.seq = seq
    if (result.accepted.length > 0) {
      this.#emit(agentId)
    }
    return true
  }

  async #coverBoundary(
    agentId: string,
    feed: Feed,
    page: TranscriptPage,
    visibleTurns: number,
    boundaryOrdinal: number | undefined,
  ): Promise<TranscriptPage | undefined> {
    let current = page
    while (current.hasMoreOlder) {
      const loaded = current.items.filter((item) => item.kind === 'turn')
      const first = loaded[0]
      if (
        loaded.length >= visibleTurns &&
        (boundaryOrdinal === undefined || (first !== undefined && first.ordinal <= boundaryOrdinal))
      ) {
        break
      }
      if (first === undefined) {
        invariant(false, 'Transcript history has no pagination boundary.')
      }
      const earlier = await this.#read(agentId, feed, () =>
        this.#port.readTranscript(this.sessionId, agentId, first.turnId),
      )
      if (earlier === undefined || !this.#owns(agentId, feed)) {
        return undefined
      }
      this.#validate(earlier, agentId)
      if (earlier.seq < current.seq) {
        invariant(false, 'Transcript history crossed a cursor reset.')
      }
      const expanded: TranscriptPage = prependOlder(current, earlier)
      const next = expanded.items.find((item) => item.kind === 'turn')
      if (
        expanded.hasMoreOlder &&
        (next === undefined || next.turnId === first.turnId || next.ordinal >= first.ordinal)
      ) {
        invariant(false, 'Transcript pagination did not advance.')
      }
      current = expanded
    }
    return current
  }

  async #head(agentId: string, feed: Feed, minimumSeq = feed.seq): Promise<void> {
    const visible = this.#transcript.getAgent(agentId)?.snapshot().items ?? []
    const turns = visible.filter((item) => item.kind === 'turn')
    const boundary = turns[0]
    const head = await this.#read(agentId, feed, () => this.#port.readTranscript(this.sessionId, agentId))
    if (head === undefined || !this.#owns(agentId, feed)) {
      return
    }
    this.#validate(head, agentId)
    if (head.seq < minimumSeq) {
      invariant(false, 'Recovery snapshot did not cover the observed transcript gap.')
    }
    // reset 可以只带一条空尾巴：可见窗口改走读路径恢复。
    const page = await this.#coverBoundary(agentId, feed, head, turns.length, boundary?.ordinal)
    if (page === undefined || !this.#owns(agentId, feed)) {
      return
    }
    this.#install(page, false, feed)
  }

  #validate(page: TranscriptPage, agentId: string): void {
    if (page.agentId !== agentId) {
      invariant(false, 'Transcript snapshot changed agent identity.')
    }
    if (!Number.isSafeInteger(page.seq) || page.seq < 0) {
      invariant(false, 'Transcript snapshot has an invalid sequence.')
    }
  }

  #install(page: TranscriptPage, prepend: boolean, feed: Feed): void {
    if (!this.#owns(page.agentId, feed)) {
      return
    }
    this.#validate(page, page.agentId)
    if (!prepend && page.seq < feed.seq) {
      if (!feed.valid) {
        invariant(false, 'Recovery snapshot precedes the committed transcript cursor.')
      }
      return
    }
    for (const descriptor of page.agents) {
      this.#transcript.describeAgent(descriptor)
    }
    const reducer = this.#transcript.ensureAgent(page.agentId)
    const snapshot = prepend ? prependOlder(reducer.snapshot(), page) : page
    const applied = reducer.receive([{ op: 'reset', agentId: page.agentId, snapshot }])
    if (applied.gap !== undefined) {
      invariant(false, 'Official transcript reducer rejected a reset.')
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
      invariant(false, 'Transcript reducer has no owning agent.')
    }
    this.#publish(agentId, reducer.snapshot())
  }
}
