/*
 * 桥这一侧的屏幕经过镜像。
 *
 * 推送是唯一产地：ops 由投影器产出、由这里编号后推给 Rust。但打开一条会话要一页
 * 基线、断流要一次追赶，那两条读总得有东西可答 —— 所以每推一批就落进这里，读的
 * 时候从它答。这不是第二套正文，就是同一批 ops 的回放。
 *
 * 水位（seq）只有这一个发放点：Rust 侧靠它判增量连不连续（transcript-replica.ts 的
 * `#advance` 要求 seq 恰好是上一条加一），另起一个计数器就是两个水位。
 */

import {
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
  TranscriptStore,
} from '@poietica/transcript'

/** 一条 agent 都还没有过任何 ops 时的空快照。 */
const EMPTY: AgentTranscriptSnapshot = {
  items: [],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
  hasMoreOlder: false,
}

/** 与 packages/transcript 的 agentIdSchema 同一个词：主线 agent 的号。 */
const MAIN_AGENT = 'main'

export class TranscriptMirror {
  readonly #store: TranscriptStore
  readonly #batches: TranscriptOperation[][] = []
  #seq = 0

  constructor(sessionId: string) {
    this.#store = new TranscriptStore(sessionId)
  }

  get seq(): number {
    return this.#seq
  }

  /**
   * 收下一批：落进镜像，回交要推出去的那一行载荷。
   *
   * 交回的是**信封**（`{type, payload}`），不是裸的 ops 表：Rust 原样转给
   * native-bridge，由它按 packages/transcript 钉住的形状校验，而那边认的正是这个
   * 信封（transcript-decoding.ts 要求顶层同时有 `type` 与 `payload`）。
   */
  accept(ops: readonly TranscriptOperation[]): unknown {
    this.#seq += 1
    this.#batches.push([...ops])
    this.#store.ensureAgent(MAIN_AGENT).receive(ops)

    return {
      type: 'transcript.ops',
      payload: { agent_id: MAIN_AGENT, seq: this.#seq, ops },
    }
  }

  /**
   * 打开一条会话时那一页。
   *
   * `has_more` 恒为 false：本机手上就是这条会话的全部 ops，没有更早的一页可翻。
   * 历史不在这里 —— omp 的会话由 `SessionManager.create` 新开，这条会话之前没有正文。
   */
  page(agentId: string): unknown {
    const snapshot = this.#store.getAgent(agentId)?.snapshot() ?? EMPTY

    return {
      agent_id: agentId,
      items: snapshot.items,
      has_more: snapshot.hasMoreOlder ?? false,
      tasks: snapshot.tasks,
      interactions: snapshot.interactions,
      attachments: snapshot.attachments,
      todos: snapshot.todos,
      prompts: snapshot.prompts,
      meta: snapshot.meta,
      agents: [{ agentId: MAIN_AGENT, type: 'main' }],
      pending_interactions: [],
      seq: this.#seq,
    }
  }

  /**
   * 从 `sinceSeq` 起的增量。
   *
   * 批次日志从 1 号起一条不少，所以任何 `sinceSeq >= 0` 都补得齐 —— `complete` 因此
   * 恒为 true。它是「journal 够不够得着 since_seq」，不是「两家水位是否相等」。
   */
  catchUp(agentId: string, sinceSeq: number): unknown {
    const batches = this.#batches
      .map((ops, at) => ({ seq: at + 1, ops }))
      .filter((batch) => batch.seq > sinceSeq)

    return { agent_id: agentId, batches, latest_seq: this.#seq, complete: true }
  }
}
