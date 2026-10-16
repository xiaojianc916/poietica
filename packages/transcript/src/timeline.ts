import type { z } from 'zod'
import { agentTranscriptSnapshotSchema } from './upstream/contract/schema'
import type { TurnId } from './upstream/model/ids'
import { itemId } from './upstream/model/item'
import { type AgentState, applyOperation, EMPTY_AGENT_STATE } from './upstream/ops/apply'
import type { AgentTranscriptSnapshot, AppendTarget, TranscriptOperation } from './upstream/ops/operation'

/** 线上传输的时间线快照（纯 JSON），即上游的 AgentTranscriptSnapshot。 */
export type TranscriptPage = AgentTranscriptSnapshot
/** 内存中的时间线状态（带索引，不可变），即上游的 AgentState。 */
export type TimelineState = AgentState

/*
 * 契约里描述 TranscriptPage 的 zod schema。运行时用上游的 schema，编译期把**输出类型**钉回上游的
 * AgentTranscriptSnapshot：zod 的推断会把可选字段放宽成 `?: T | undefined`，与上游模型在
 * exactOptionalPropertyTypes 之下的形状不同（而线上跑的就是上游那一份 JSON）。不钉住的话，引擎端口
 * 交出的 `page`（上游类型）就没法与契约推导出的类型互相赋值 —— 两边说的是同一件事。
 */
export const transcriptPageSchema: z.ZodType<TranscriptPage> =
  agentTranscriptSnapshotSchema as unknown as z.ZodType<TranscriptPage>

/** append 的 offset 超出当前长度或与已有内容冲突：副本已不可信，调用方必须整页重取（重新订阅）。 */
export class TranscriptGapError extends Error {
  override readonly name = 'TranscriptGapError'
  constructor(
    readonly target: AppendTarget | null,
    readonly expected: number,
    readonly got: number,
  ) {
    super(`时间线增量出现缺口：期望偏移 ${expected}，收到 ${got}`)
  }
}

export function emptyTimeline(): TimelineState {
  return EMPTY_AGENT_STATE
}

export function stateFromPage(page: TranscriptPage): TimelineState {
  // reset 的 agentId 只用于上游的多 agent 存储，这里不使用；传固定值即可
  return applyOperation(EMPTY_AGENT_STATE, { op: 'reset', agentId: 'local', snapshot: page }).state
}

export function pageFromState(state: TimelineState): TranscriptPage {
  return {
    items: state.items,
    tasks: [...state.tasks.values()],
    interactions: [...state.interactions.values()],
    attachments: [...state.attachments.values()],
    todos: [...state.todos.values()],
    prompts: [...state.prompts.values()],
    meta: state.meta,
    hasMoreOlder: state.hasMoreOlder,
  }
}

/**
 * 依次应用一批 op，返回新状态（输入状态不被修改）；没有任何变化时返回同一个对象（便于 React 跳过渲染）。
 * 任何一条 append 出现缺口 → 抛 TranscriptGapError，整批作废。
 */
export function applyOps(state: TimelineState, ops: readonly TranscriptOperation[]): TimelineState {
  let next = state
  for (const op of ops) {
    const result = applyOperation(next, op)
    if (result.gap !== undefined) {
      throw new TranscriptGapError(op.op === 'append' ? op.target : null, result.gap.expected, result.gap.got)
    }
    if (result.changed) next = result.state
  }
  return next
}

/**
 * 把更早的一页拼到当前这一页前面（「加载更早的消息」）。条目与侧表：older 里已在当前页出现的 id 被丢弃
 * （当前页更新），其余排在前面；meta 与其余字段取当前页；hasMoreOlder 取 older 的值。
 *
 * 只有页的形状、不碰索引状态：调用方（界面副本）手里本来就是页，转一次索引状态再转回来是白算。
 */
export function prependOlder<P extends TranscriptPage>(current: P, older: TranscriptPage): P {
  const mergeBy = <T>(earlier: readonly T[], present: readonly T[], key: (value: T) => string): T[] => {
    const prefix = new Map(earlier.map((value) => [key(value), value]))
    for (const value of present) prefix.delete(key(value))
    return [...prefix.values(), ...present]
  }
  return {
    ...current,
    items: mergeBy(older.items, current.items, itemId),
    tasks: mergeBy(older.tasks, current.tasks, (t) => t.taskId),
    interactions: mergeBy(older.interactions, current.interactions, (i) => i.interactionId),
    attachments: mergeBy(older.attachments, current.attachments, (a) => a.attachmentId),
    todos: mergeBy(older.todos, current.todos, (t) => t.todoId),
    prompts: mergeBy(older.prompts, current.prompts, (p) => p.promptId),
    hasMoreOlder: older.hasMoreOlder ?? false,
  }
}

/** 当前最早一轮的 id；没有任何 turn 时为 null。加载更早内容时作为游标。 */
export function oldestTurnId(state: TimelineState): TurnId | null {
  for (const item of state.items) if (item.kind === 'turn') return item.turnId
  return null
}
