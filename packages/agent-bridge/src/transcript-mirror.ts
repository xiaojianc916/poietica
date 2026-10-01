/*
 * 桥这一侧的屏幕经过镜像。
 *
 * 推送是唯一产地：ops 由投影器产出、由这里编号后推给 Rust。但开一条会话要一页基线、
 * 断流要一次追赶，那两条读总得有东西可答 —— 所以每推一批就落进这里，读时从它答；
 * 不是第二套正文，就是同一批 ops 的回放。水位（seq）只有这一个发放点：Rust 侧靠它
 * 判增量连不连续（transcript-replica.ts 的 `#advance` 要求 seq 恰好是上一条加一），
 * 另起一个计数器就是两个水位。
 *
 * **每一条出去的帧都必须装得进一行**：Rust 侧按 `wire::MAX_LINE_BYTES` 判行长，超一行
 * 不是丢帧，是整条连接当场拆掉（bridge.rs 的读循环），屏幕上是「agent 已经退出，
 * 请重新发起对话」。所以三条读法都按字节预算收口：推按 op 切块、基线页按轮开窗、
 * 追赶按批收口。判据是**字节**不是字符 —— Rust 量的是 `line.len()`，而一个汉字三字节。
 */

import {
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
  TranscriptStore,
  type TranscriptTurn,
} from '@poietica/transcript'
import { MAX_FRAME_BYTES } from './protocol.ts'

/** 快照里一条条目（轮 / 标记 / 任务引用）。从快照自己的形状取，不另开一个导出。 */
type TranscriptItem = AgentTranscriptSnapshot['items'][number]

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

/*
 * 留给信封与 JSON 标点的余量。
 *
 * 预算量的是 ops 自己的字节，而线上那一行还包着 `{type, payload, agent_id, seq, ops: […]}`，
 * 外加 main.ts 那层 `{type:'event', event:…}`。这点开销是常数级（几十字节），
 * 留 64 KiB 已是千倍富余 —— 富余不是浪费，它换来的是「预算之内的载荷一个字节都不动」。
 */
const ENVELOPE_RESERVE_BYTES = 64 * 1024

/** 生产者自己的单帧预算。传输上限只兜底，收口在这里。 */
const FRAME_BUDGET_BYTES = MAX_FRAME_BYTES - ENVELOPE_RESERVE_BYTES

const encoder = new TextEncoder()

/** 一个值在线上占多少**字节**。Rust 侧量的就是它，不是字符数。 */
function bytesOf(value: unknown): number {
  const text = JSON.stringify(value)

  return text === undefined ? 0 : encoder.encode(text).byteLength
}

/** 按预算把一批 op 切成若干块；单条 op 自己就超预算时独占一块（协议没有更细的切法）。 */
function chunkOps(ops: readonly TranscriptOperation[], budget: number): TranscriptOperation[][] {
  const chunks: TranscriptOperation[][] = []
  let current: TranscriptOperation[] = []
  let used = 0

  for (const op of ops) {
    const size = bytesOf(op)

    if (current.length > 0 && used + size > budget) {
      chunks.push(current)
      current = []
      used = 0
    }

    current.push(op)
    used += size
  }

  if (current.length > 0) {
    chunks.push(current)
  }

  return chunks
}

/*
 * 一轮自己就超预算时的兜底：从最老的步骤开始丢，直到装得下。
 *
 * 这是安全阀，不是常规路径 —— 翻页游标是**轮号**（transcript-store 的 `earlier`），
 * 所以丢掉的步骤客户端翻不回来。它只在「一轮比整页预算还大」时触发；要让这一步彻底
 * 不发生，得把翻页游标细到步骤，那是契约改动（schema 的 before_turn 与客户端游标
 * 一起改），不在这次修复里。
 */
function trimTurn(turn: TranscriptTurn, budget: number): TranscriptTurn {
  for (let drop = 0; drop <= turn.steps.length; drop += 1) {
    const candidate: TranscriptTurn = { ...turn, steps: turn.steps.slice(drop) }

    if (bytesOf(candidate) <= budget) {
      return candidate
    }
  }

  return { ...turn, steps: [] }
}

interface Window {
  readonly items: readonly TranscriptItem[]
  readonly hasMore: boolean
}

/*
 * 基线页开窗：从最新往回装，装到预算为止。
 *
 * `beforeTurn` 在场即「只要比这一轮更早的那些」—— 那是客户端翻页的读法
 * （transcript-store 的 readEarlier 把当前最早那一轮的号交上来）。认不出的轮号回空页：
 * 回整页会让翻页永远不前进，而客户端把「没推进」当缺陷抛（#coverBoundary）。
 */
function windowItems(
  items: readonly TranscriptItem[],
  beforeTurn: string | undefined,
  budget: number,
): Window {
  let pool = items

  if (beforeTurn !== undefined) {
    const at = pool.findIndex((item) => item.kind === 'turn' && item.turnId === beforeTurn)

    if (at < 0) {
      return { items: [], hasMore: false }
    }

    pool = pool.slice(0, at)
  }

  let used = 0
  let start = pool.length

  while (start > 0) {
    const item = pool[start - 1]

    if (item === undefined) {
      break
    }

    const size = bytesOf(item)

    if (used + size > budget) {
      break
    }

    used += size
    start -= 1
  }

  /* 最新那一条自己就超预算：是轮就把步骤裁到装得下，仍如实说还有更早的。 */
  if (start === pool.length && pool.length > 0) {
    const newest = pool[pool.length - 1]

    if (newest === undefined) {
      return { items: [], hasMore: false }
    }

    return {
      items: [newest.kind === 'turn' ? trimTurn(newest, budget) : newest],
      hasMore: true,
    }
  }

  return { items: pool.slice(start), hasMore: start > 0 }
}

/*
 * 附件按引用收口。
 *
 * 这一格是页里唯一可能上百 MB 的东西：每张图都以 data URL 内联（`attachment.upsert`），
 * 而它是**累加**的 —— 整条会话贴过的图全在里面。开窗只裁 items，图不裁就还是顶穿。
 *
 * 判据是「开出来的那些轮引用了谁」：投影层只按轮里的 attachmentIds 去查附件
 * （transcript-projector 的 attachmentsOfTurn），所以没被引用的那几张此刻不画，
 * 等翻到更早那一页时随 `olderSnapshot` 的合并再回来。
 */
function referencedAttachments(
  attachments: AgentTranscriptSnapshot['attachments'],
  items: readonly TranscriptItem[],
): AgentTranscriptSnapshot['attachments'] {
  const referenced = new Set<string>()

  for (const item of items) {
    if (item.kind !== 'turn') {
      continue
    }

    for (const id of item.attachmentIds ?? []) {
      referenced.add(id)
    }
  }

  return attachments.filter((attachment) => referenced.has(attachment.attachmentId))
}

/** 按预算留下前几个；装不下的丢掉（调用方决定这是降级还是翻页）。 */
function takeWithinBudget<T>(values: readonly T[], budget: number): readonly T[] {
  const kept: T[] = []
  let used = 0

  for (const value of values) {
    const size = bytesOf(value)

    if (used + size > budget) {
      break
    }

    used += size
    kept.push(value)
  }

  return kept
}

export class TranscriptMirror {
  readonly #store: TranscriptStore
  readonly #batches: TranscriptOperation[][] = []
  readonly #budget: number
  #seq = 0

  /**
   * `budgetBytes` 只为自检而可注入：切块与开窗都要拿「比预算大」的数据才验得出来，
   * 而按真预算造夹具得堆几 MB。生产只走默认值（组合根只 new 一次，不传第二个参数）。
   */
  constructor(sessionId: string, budgetBytes: number = FRAME_BUDGET_BYTES) {
    this.#store = new TranscriptStore(sessionId)
    this.#budget = budgetBytes
  }

  get seq(): number {
    return this.#seq
  }

  /**
   * 收下一批：落进镜像，回交要推出去的每一行载荷。
   *
   * 交回的是**信封表**（`{type, payload}` 各一条），不是裸的 ops 表：Rust 原样转给
   * native-bridge，由它按 packages/transcript 钉住的形状校验，而那边认的正是这个
   * 信封（transcript-decoding.ts 要求顶层同时有 `type` 与 `payload`）。
   *
   * 一批切成几行由预算说了算，每行一个自己的 seq —— 客户端按「恰好加一」判连续，
   * 所以切块只许在这里发生，调用方按顺序逐条推出去。
   */
  accept(ops: readonly TranscriptOperation[]): unknown[] {
    const envelopes: unknown[] = []

    for (const chunk of chunkOps(ops, this.#budget)) {
      this.#seq += 1
      this.#batches.push([...chunk])
      this.#store.ensureAgent(MAIN_AGENT).receive(chunk)

      envelopes.push({
        type: 'transcript.ops',
        payload: { agent_id: MAIN_AGENT, seq: this.#seq, ops: chunk },
      })
    }

    return envelopes
  }

  /**
   * 打开一条会话时那一页。
   *
   * `has_more` 说的是「还有更早的**轮**」：本机手上就是这条会话的全部 ops，但一页装不下
   * 时只交最新的那一截，更早的由 `beforeTurn` 再翻。历史不在这里 —— omp 的会话由
   * `SessionManager.create` 新开，这条会话之前没有正文。
   *
   * 预算的次序是**先正文后图**：正文是翻页能补回来的那部分，图不是（见下面的收口），
   * 所以让可恢复的先占。附件只保留开出来的那些轮引用到的（引用关系只有开完窗才知道，
   * 这也是次序不能反过来的原因）。
   */
  page(agentId: string, beforeTurn?: string): unknown {
    const agent = this.#store.getAgent(agentId)
    const snapshot = agent?.snapshot() ?? EMPTY

    /* 除轮与附件外的几格（任务、交互、题面、meta）先扣掉：它们小且不可裁。 */
    const overhead = bytesOf({
      agent_id: agentId,
      tasks: snapshot.tasks,
      interactions: snapshot.interactions,
      todos: snapshot.todos,
      prompts: snapshot.prompts,
      meta: snapshot.meta,
      pending_interactions: agent?.listPendingInteractions() ?? [],
    })
    let remaining = Math.max(this.#budget - overhead, 0)

    const window = windowItems(snapshot.items, beforeTurn, remaining)
    remaining = Math.max(remaining - bytesOf(window.items), 0)

    /*
     * 只留开出来的那些轮引用到的图（投影层只按轮里的 attachmentIds 查附件），再按剩下的
     * 预算收口。
     *
     * 这里裁掉图**是功能降级不是翻页游标**：客户端的游标是轮号，翻页回不来被裁掉的图。
     * 它换来的是「一条图片很多的会话仍然打得开」—— 顶穿单行是整条连接死掉，比少画几张
     * 缩略图坏得多。要让这一步不发生，得让附件走引用（`session_media`）而不是内联
     * base64，那是桥与原生两侧的取字节通道，不在这次修复里。
     */
    const referenced = referencedAttachments(snapshot.attachments, window.items)
    const held = takeWithinBudget(referenced, remaining)

    return {
      agent_id: agentId,
      items: window.items,
      has_more: window.hasMore,
      tasks: snapshot.tasks,
      interactions: snapshot.interactions,
      attachments: held,
      todos: snapshot.todos,
      prompts: snapshot.prompts,
      meta: snapshot.meta,
      agents: [{ agentId: MAIN_AGENT, type: 'main' }],
      // 与 interactions 同一份事实的两个出口：这个是水位的读法，那个是内容。
      pending_interactions: agent?.listPendingInteractions() ?? [],
      seq: this.#seq,
    }
  }

  /**
   * 从 `sinceSeq` 起的增量。
   *
   * 批次日志从 1 号起一条不少，所以任何 `sinceSeq >= 0` 都补得齐。装不下的那一趟只交
   * 装得下的前缀，并把 `complete` 报假 —— 客户端据此退回整页读法（transcript-replica
   * 的 `foldCatchUp` 只在 complete 时才折叠），那条路是开过窗的，不会再顶穿。
   */
  catchUp(agentId: string, sinceSeq: number): unknown {
    const batches: { seq: number; ops: readonly TranscriptOperation[] }[] = []
    let used = 0

    for (const [at, ops] of this.#batches.entries()) {
      const seq = at + 1

      if (seq <= sinceSeq) {
        continue
      }

      const entry = { seq, ops }
      const size = bytesOf(entry)

      if (batches.length > 0 && used + size > this.#budget) {
        break
      }

      used += size
      batches.push(entry)
    }

    const last = batches[batches.length - 1]

    return {
      agent_id: agentId,
      batches,
      latest_seq: this.#seq,
      complete: last === undefined || last.seq === this.#seq,
    }
  }
}
