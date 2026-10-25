import {
  applyOps,
  emptyTimeline,
  type TimelineState,
  type TranscriptOperation,
  type TranscriptPage,
  type TranscriptTurn,
} from '@poietica/transcript'

/**
 * 开着的那一轮**在屏幕上已经是什么样** —— 只由实时那条路（`LiveProjector`）此前发出去的 op 叠出来。
 * 时间线有两个产地：封口的轮由历史投影算出，开着的轮由实时投影推出来。两边帧号相同（R-27）但
 * **段的划分不同**，且历史那边看不到还在流的那条消息 —— 整页重取若取历史版本，之后的实时增量
 * 就落在另一套段号上：正在跑的工具出现两张卡片（一张永远转圈），正在流的正文每个增量都报缺口。
 * 所以开着的那一轮只认一个产地：整页里的这一轮换成这里的版本，封口的轮仍归历史投影 ——
 * 界面因此任何时候都可以整页重取，不再有「一轮开着时别整页重取」这条约束。
 */
export class OpenTurnScreen {
  private state: TimelineState | null = null
  private turnId: string | null = null

  /**
   * 记下一批刚发出去的 op。新开一轮（`turn.upsert` 且 running、号是新的）时从空状态重来：
   * 同一批里排在轮头前面的附件条目一起算进去；上一轮的东西一概不留（它已封口，归历史投影）。
   * 叠不上（理论上不会：这里收到的就是界面收到的同一串 op）→ 返回 false 并放弃，整页回到只用历史投影。
   */
  observe(ops: readonly TranscriptOperation[]): boolean {
    const opened = openingOf(ops, this.turnId)
    if (opened !== null) {
      this.state = emptyTimeline()
      this.turnId = opened
    }
    if (this.state === null) return true
    try {
      this.state = applyOps(this.state, ops)
    } catch {
      this.clear()
      return false
    }
    if (this.turn()?.state !== 'running') this.clear()
    return true
  }

  clear(): void {
    this.state = null
    this.turnId = null
  }

  /**
   * 此刻开着的那一轮在屏幕上的样子（不可变快照）。整页要在**同一刻**取它与历史投影：
   * 取完再等一拍，中间可能又发出了几条增量。
   */
  view(): OpenTurnView | null {
    const id = this.turnId
    const state = this.state
    if (id === null || state === null) return null
    const turn = state.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === id)
    return turn === undefined ? null : { turn, state }
  }

  private turn(): TranscriptTurn | undefined {
    return this.view()?.turn
  }
}

export interface OpenTurnView {
  readonly turn: TranscriptTurn
  readonly state: TimelineState
}

/**
 * 把整页里开着的那一轮换成屏幕上的版本。历史里已经有这一轮（号相同）就原位替换；还没有
 * （omp 还没把这句话写进消息，例如发送前的自动压缩还在跑）而且这是最新一页，就接在末尾。
 * 这一轮的附件条目与 `meta`（activity 等）一并补上 —— 它们也只在实时那条路上发过。
 */
export function overlayOpenTurn(page: TranscriptPage, view: OpenTurnView | null, newest: boolean): TranscriptPage {
  if (view === null) return page
  const { turn, state } = view
  const at = page.items.findIndex((item) => item.kind === 'turn' && item.turnId === turn.turnId)
  if (at < 0 && !newest) return page
  const items = at < 0 ? [...page.items, turn] : page.items.map((item, index) => (index === at ? turn : item))
  const known = new Set(page.attachments.map((attachment) => attachment.attachmentId))
  const attachments = [
    ...page.attachments,
    ...[...state.attachments.values()].filter((attachment) => !known.has(attachment.attachmentId)),
  ]
  return { ...page, items, attachments, meta: { ...page.meta, ...state.meta } }
}

/** 这批 op 里新开的那一轮的号（running 的轮头，号与手上那一轮不同）；没有就是 null */
function openingOf(ops: readonly TranscriptOperation[], current: string | null): string | null {
  for (const op of ops) {
    if (op.op === 'turn.upsert' && op.turn.state === 'running' && op.turn.turnId !== current) return op.turn.turnId
  }
  return null
}
