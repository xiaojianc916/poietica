import type { OmpToolInputOf } from '@poietica/omp-types'
import type { AgentEvent, CommittedAgentEvent, EphemeralAgentEvent, ThreadSnapshot } from './events'
import type { ToolFrameProgress, TranscriptFrame } from './model/frame'
import type { TranscriptInteraction } from './model/interaction'
import type { TranscriptItem } from './model/item'
import type { TranscriptTask } from './model/task'
import type { TranscriptTurn } from './model/turn'
import type { AgentState } from './ops/apply'
import { appendAtOffset, applyOperation, EMPTY_AGENT_STATE } from './ops/apply'
import type { StepHeader, TranscriptOperation, TurnHeader } from './ops/operation'

/*
 * 唯一的 fold（架构设计 §11.2）。
 *
 * 已提交层只由 committed 事件决定；ephemeral 事件只写实时覆盖层，不改变已提交层。
 * 同一个 ThreadReducer 同时给 Core 的快照与 UI 的本地副本使用，所以两边不会各投影一份。
 */

export interface FrameOverlay {
  readonly text?: string
  readonly input?: unknown
  readonly output?: string
  readonly progress?: ToolFrameProgress
}

export interface ThreadOverlay {
  readonly frames: ReadonlyMap<string, FrameOverlay>
  readonly tasks: ReadonlyMap<string, string>
}

export interface ThreadState {
  readonly committed: AgentState
  readonly overlay: ThreadOverlay
  /** 已经有终态条目的号：重复到达的 item.started 不许把终态退回运行中 */
  readonly completedItems: ReadonlySet<string>
}

export const EMPTY_THREAD_STATE: ThreadState = {
  committed: EMPTY_AGENT_STATE,
  overlay: { frames: new Map(), tasks: new Map() },
  completedItems: new Set(),
}

export function reduce(state: ThreadState, event: AgentEvent): ThreadState {
  if (event.durability === 'ephemeral') return applyEphemeral(state, event)
  return applyCommitted(state, event)
}

export function reduceAll(state: ThreadState, events: readonly AgentEvent[]): ThreadState {
  let next = state
  for (const event of events) next = reduce(next, event)
  return next
}

export interface ReduceGap {
  readonly expected: number
  readonly got: number
}

/** 增量缺口的判据：offset 必须正好接在当前正文末尾，内容重叠也必须一致。 */
export function reduceAllChecked(
  state: ThreadState,
  events: readonly AgentEvent[],
): { readonly state: ThreadState; readonly gap?: ReduceGap } {
  let next = state
  for (const event of events) {
    if (event.durability === 'ephemeral') {
      const gap = gapOf(next, event)
      if (gap !== undefined) return { state, gap }
    }
    next = reduce(next, event)
  }
  return { state: next }
}

function gapOf(state: ThreadState, event: EphemeralAgentEvent): ReduceGap | undefined {
  if (event.type === 'task.output') {
    if (event.offset === undefined || event.text === undefined) return undefined
    const current = state.overlay.tasks.get(event.taskId) ?? state.committed.tasks.get(event.taskId)?.outputTail ?? ''
    return appendAtOffset(current, event.offset, event.text).gap
  }
  if (event.type === 'item.delta' && event.channel !== 'tool_input' && event.channel !== 'progress') {
    if (event.offset === undefined || event.text === undefined) return undefined
    const current = overlayTextOf(state, event.frameId) ?? frameTextOf(state, event.frameId) ?? ''
    return appendAtOffset(current, event.offset, event.text).gap
  }
  return undefined
}

function overlayTextOf(state: ThreadState, frameId: string): string | undefined {
  const overlay = state.overlay.frames.get(frameId)
  if (overlay === undefined) return undefined
  return overlay.output !== undefined && overlay.text === undefined ? overlay.output : overlay.text
}

function frameTextOf(state: ThreadState, frameId: string): string | undefined {
  const frame = allFrames(state.committed).find((entry) => entry.frameId === frameId)
  if (frame === undefined) return undefined
  if (frame.kind === 'text' || frame.kind === 'thinking') return frame.text
  return frame.kind === 'tool' && typeof frame.output === 'string' ? frame.output : undefined
}

function allFrames(state: AgentState): readonly TranscriptFrame[] {
  return state.items.flatMap((item) => (item.kind === 'turn' ? item.steps.flatMap((step) => step.frames) : []))
}

function applyCommitted(state: ThreadState, event: CommittedAgentEvent): ThreadState {
  switch (event.type) {
    case 'thread.titled':
    case 'thread.forked':
    case 'thread.archived':
    case 'usage.recorded':
      /* 线程元数据与账本由领域模块持有；时间线状态不重复存一份。 */
      return state
    default:
      break
  }
  if (event.type.startsWith('run.') || event.type.startsWith('step.')) {
    return applyRunCommitted(state, event as Extract<CommittedAgentEvent, { type: `run.${string}` | `step.${string}` }>)
  }
  if (
    event.type.startsWith('item.') ||
    event.type === 'context.compacted' ||
    event.type === 'marker.raised' ||
    event.type === 'task.linked'
  ) {
    return applyTimelineCommitted(state, event)
  }
  if (event.type === 'agent.updated' || event.type === 'notice.raised') {
    return applyAgentCommitted(state, event)
  }
  return applySideCommitted(state, event)
}

type RunCommitted = Extract<CommittedAgentEvent, { type: `run.${string}` | `step.${string}` }>

function applyRunCommitted(state: ThreadState, event: RunCommitted): ThreadState {
  switch (event.type) {
    case 'run.queued':
    case 'run.started':
      return startRun(state, event.run)
    case 'run.completed':
      return completeRun(state, event)
    case 'run.input_enqueued':
    case 'run.input_withdrawn':
    case 'run.input_consumed':
    case 'run.input_dropped':
      return withPatch(state, { op: 'prompt.upsert', prompt: event.prompt })
    case 'step.started':
    case 'step.retrying':
      return startStep(state, event.turnId, event.step)
    case 'step.completed':
      return withPatch(state, { op: 'step.upsert', turnId: event.turnId, step: event.step })
    default:
      return state
  }
}

function applyTimelineCommitted(state: ThreadState, event: CommittedAgentEvent): ThreadState {
  switch (event.type) {
    case 'item.started':
    case 'item.completed':
    case 'item.failed':
      return upsertFrame(state, event)
    case 'item.removed':
      return withPatch(state, { op: 'items.remove', ids: event.ids })
    case 'context.compacted':
    case 'marker.raised':
      return withPatch(state, { op: 'marker.upsert', item: event.item, beforeTurn: event.beforeTurn })
    case 'task.linked':
      return withPatch(state, { op: 'taskref.upsert', item: event.item, beforeTurn: event.beforeTurn })
    default:
      return state
  }
}

function applyAgentCommitted(state: ThreadState, event: CommittedAgentEvent): ThreadState {
  if (event.type === 'agent.updated') return withPatch(state, { op: 'meta.merge', meta: event.meta })
  if (event.type === 'notice.raised') {
    return withPatch(state, { op: 'frame.upsert', turnId: event.turnId, stepId: event.stepId, frame: event.frame })
  }
  return state
}

function applySideCommitted(state: ThreadState, event: CommittedAgentEvent): ThreadState {
  switch (event.type) {
    case 'interaction.requested':
      return requestInteraction(state, event.interaction)
    case 'interaction.resolved':
      return withPatch(state, { op: 'interaction.upsert', interaction: event.interaction })
    case 'task.started':
      return startTask(state, event.task)
    case 'task.finished':
      return withPatch(state, { op: 'task.upsert', task: event.task })
    case 'attachment.added':
      return withPatch(state, { op: 'attachment.upsert', attachment: event.attachment })
    case 'todo.updated':
      return withPatch(state, { op: 'todo.upsert', todo: event.todo })
    case 'prompt.updated':
      return withPatch(state, { op: 'prompt.upsert', prompt: event.prompt })
    default:
      return state
  }
}

function completeRun(state: ThreadState, event: Extract<CommittedAgentEvent, { type: 'run.completed' }>): ThreadState {
  const turn = findTurn(state.committed, event.runId)
  if (turn === undefined) return state
  const header: TurnHeader = {
    ...turnHeaderOf(turn),
    state: event.outcome === 'interrupted' ? 'cancelled' : event.outcome,
    ...(event.endedAt === undefined ? {} : { endedAt: event.endedAt }),
    ...(event.usage === undefined ? {} : { usage: event.usage }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.error === undefined ? {} : { error: event.error }),
  }
  return withPatch(state, { op: 'turn.upsert', turn: header })
}

function upsertFrame(
  state: ThreadState,
  event: Extract<CommittedAgentEvent, { type: 'item.started' | 'item.completed' | 'item.failed' }>,
): ThreadState {
  const frameId = event.frame.frameId
  if (event.type === 'item.started' && state.completedItems.has(frameId)) return state
  const overlay = withoutFrame(state.overlay, frameId)
  const next = overlay === state.overlay ? state : { ...state, overlay }
  const changed = withPatch(next, {
    op: 'frame.upsert',
    turnId: event.turnId,
    stepId: event.stepId,
    frame: event.frame,
  })
  if (event.type === 'item.started' || changed.completedItems.has(frameId)) return changed
  const completedItems = new Set(changed.completedItems)
  completedItems.add(frameId)
  return { ...changed, completedItems }
}

function startRun(state: ThreadState, run: TurnHeader): ThreadState {
  const existing = findTurn(state.committed, run.turnId)
  if (existing !== undefined && existing.state !== 'running' && existing.state !== 'queued') return state
  return withPatch(state, { op: 'turn.upsert', turn: run })
}

function startStep(state: ThreadState, turnIdValue: string, step: StepHeader): ThreadState {
  const turn = findTurn(state.committed, turnIdValue)
  const existing = turn?.steps.find((entry) => entry.stepId === step.stepId)
  if (existing !== undefined && existing.state !== 'running') return state
  return withPatch(state, { op: 'step.upsert', turnId: turnIdValue, step })
}

function requestInteraction(state: ThreadState, interaction: TranscriptInteraction): ThreadState {
  const existing = state.committed.interactions.get(interaction.interactionId)
  if (existing !== undefined && existing.state !== 'pending') return state
  return withPatch(state, { op: 'interaction.upsert', interaction })
}

function startTask(state: ThreadState, task: TranscriptTask): ThreadState {
  const existing = state.committed.tasks.get(task.taskId)
  if (existing !== undefined && existing.state !== 'running') return state
  return withPatch(state, { op: 'task.upsert', task })
}

function withPatch(state: ThreadState, patch: TranscriptOperation): ThreadState {
  const result = applyOperation(state.committed, patch)
  return result.changed ? { ...state, committed: result.state } : state
}

function applyEphemeral(state: ThreadState, event: EphemeralAgentEvent): ThreadState {
  switch (event.type) {
    case 'item.delta':
      return withFrameOverlay(state, event.frameId, (current) => deltaOverlay(current, event))
    case 'task.output':
      return withTaskOverlay(state, event.taskId, (current) => mergeText(current, event))
    case 'command.output':
      return state
  }
}

function deltaOverlay(
  current: FrameOverlay,
  event: Extract<EphemeralAgentEvent, { type: 'item.delta' }>,
): FrameOverlay {
  switch (event.channel) {
    case 'text':
    case 'thinking':
      return { ...current, text: mergeText(current.text ?? '', event) }
    case 'tool_input':
      return { ...current, input: event.data ?? event.text ?? current.input }
    case 'tool_output':
      return { ...current, output: mergeText(current.output ?? '', event) }
    case 'progress':
      return { ...current, progress: event.data as ToolFrameProgress | undefined }
  }
}

function mergeText(current: string, event: { readonly offset?: number; readonly text?: string }): string {
  if (event.text === undefined) return current
  if (event.offset === undefined) return event.text
  const merged = appendAtOffset(current, event.offset, event.text)
  return merged.gap === undefined ? merged.text : current
}

function withFrameOverlay(
  state: ThreadState,
  frameId: string,
  update: (current: FrameOverlay) => FrameOverlay,
): ThreadState {
  const current = state.overlay.frames.get(frameId) ?? {}
  const nextOverlay = update(current)
  if (sameFrameOverlay(current, nextOverlay)) return state
  const frames = new Map(state.overlay.frames)
  frames.set(frameId, nextOverlay)
  return { ...state, overlay: { ...state.overlay, frames } }
}

function withTaskOverlay(state: ThreadState, taskId: string, update: (current: string) => string): ThreadState {
  const current = state.overlay.tasks.get(taskId) ?? ''
  const nextText = update(current)
  if (nextText === current) return state
  const tasks = new Map(state.overlay.tasks)
  tasks.set(taskId, nextText)
  return { ...state, overlay: { ...state.overlay, tasks } }
}

function withoutFrame(overlay: ThreadOverlay, frameId: string): ThreadOverlay {
  if (!overlay.frames.has(frameId)) return overlay
  const frames = new Map(overlay.frames)
  frames.delete(frameId)
  return { ...overlay, frames }
}

function sameFrameOverlay(a: FrameOverlay, b: FrameOverlay): boolean {
  return a.text === b.text && a.input === b.input && a.output === b.output && a.progress === b.progress
}

function findTurn(state: AgentState, turnId: string): TranscriptTurn | undefined {
  const at = state.turnIndex.get(turnId)
  const item = at === undefined ? undefined : state.items[at]
  return item?.kind === 'turn' ? item : undefined
}

function turnHeaderOf(turn: TranscriptTurn): TurnHeader {
  const { steps: _steps, ...header } = turn
  return header
}

/**
 * 把实时覆盖层压到已提交层上。UI 的视图选择器与 Core 的快照都读这一份结果；
 * 覆盖只针对正在流式输出的条目，对应条目提交后覆盖已经被 reducer 丢弃。
 */
export function materialize(state: ThreadState): AgentState {
  const { frames, tasks } = state.overlay
  if (frames.size === 0 && tasks.size === 0) return state.committed
  const committed = state.committed
  /*
   * 只碰覆盖层点到的那几个格子。
   *
   * 从前是「把每个条目、每一段、每一帧都走一遍，没覆盖的照样交回原引用」—— 结果等价，但代价是 O(全部帧)：
   * 一条几百轮的对话里，每来一批流式增量都要重扫几千帧，聊得越久每一批越贵（实测 600 轮时每批 0.19ms，
   * 其中 0.12ms 就花在这趟全表）。覆盖层只认几个 frameId，按位置表直达就行；
   * 数组本身仍要按不可变语义复制 —— 但只复制被改写的那几个 turn / step，其余位置原样留引用。
   */
  const touched = patchOf(committed, frames)
  const items = touched.size === 0 ? committed.items : patched(committed.items, touched)
  const nextTasks = tasksWithOutput(committed.tasks, tasks)
  if (items === committed.items && nextTasks === committed.tasks) return committed
  return {
    ...committed,
    items,
    tasks: nextTasks,
    turnIndex: committed.turnIndex,
  }
}

/** 任务输出覆盖：没有一条落到已知任务上时交回原表（调用方据此跳过整份状态的重建） */
function tasksWithOutput(tasks: AgentState['tasks'], overlay: ReadonlyMap<string, string>): AgentState['tasks'] {
  let next: Map<string, TranscriptTask> | undefined
  for (const [taskId, text] of overlay) {
    const task = tasks.get(taskId)
    if (task === undefined) continue
    next ??= new Map(tasks)
    next.set(taskId, { ...task, outputTail: text })
  }
  return next ?? tasks
}

/**(条目位置, 段位置) → (帧位置 → 合并后的帧)：覆盖层落到哪几个格子。一个都没落到时交回空表 */
function patchOf(
  committed: AgentState,
  frames: ReadonlyMap<string, FrameOverlay>,
): Map<number, Map<number, Map<number, TranscriptFrame>>> {
  const places = placesOf(committed)
  const touched = new Map<number, Map<number, Map<number, TranscriptFrame>>>()
  for (const [frameId, overlay] of frames) {
    const place = places.get(frameId)
    if (place === undefined) continue
    const merged = mergedFrameAt(committed, place, overlay)
    if (merged === undefined) continue
    const steps = touched.get(place.turn) ?? new Map<number, Map<number, TranscriptFrame>>()
    const inStep = steps.get(place.step) ?? new Map<number, TranscriptFrame>()
    inStep.set(place.frame, merged)
    steps.set(place.step, inStep)
    touched.set(place.turn, steps)
  }
  return touched
}

/** 某一格被覆盖后的帧；那一位不存在或内容没变时交回 undefined（不必改） */
function mergedFrameAt(committed: AgentState, place: FramePlace, overlay: FrameOverlay): TranscriptFrame | undefined {
  const turn = committed.items[place.turn]
  if (turn?.kind !== 'turn') return undefined
  const frame = turn.steps[place.step]?.frames[place.frame]
  if (frame === undefined) return undefined
  const merged = mergeFrame(frame, overlay)
  return merged === frame ? undefined : merged
}

/** 把记下的那几帧写进条目表：只复制被改写的 turn 与 step，其余位置保留原引用 */
function patched(
  items: readonly TranscriptItem[],
  touched: ReadonlyMap<number, ReadonlyMap<number, ReadonlyMap<number, TranscriptFrame>>>,
): readonly TranscriptItem[] {
  const next = items.slice()
  for (const [turnAt, steps] of touched) {
    const turn = items[turnAt]
    if (turn?.kind !== 'turn') continue
    const nextSteps = turn.steps.slice()
    for (const [stepAt, framesAt] of steps) {
      const step = turn.steps[stepAt]
      if (step === undefined) continue
      const nextFrames = step.frames.slice()
      for (const [frameAt, frame] of framesAt) nextFrames[frameAt] = frame
      nextSteps[stepAt] = { ...step, frames: nextFrames }
    }
    next[turnAt] = { ...turn, steps: nextSteps }
  }
  return next
}

interface FramePlace {
  readonly turn: number
  readonly step: number
  readonly frame: number
}

/*
 * 帧号 → 它在条目里的位置。建一次 O(全部帧)，之后每批都是直达；committed 换新对象时重建
 * （提交事件才会换，流式增量只换覆盖层）。
 */
const PLACES = new WeakMap<AgentState, ReadonlyMap<string, FramePlace>>()

function placesOf(committed: AgentState): ReadonlyMap<string, FramePlace> {
  const held = PLACES.get(committed)
  if (held !== undefined) return held
  const places = new Map<string, FramePlace>()
  for (let turnAt = 0; turnAt < committed.items.length; turnAt += 1) {
    const item = committed.items[turnAt]
    if (item?.kind === 'turn') collectTurnPlaces(item, turnAt, places)
  }
  PLACES.set(committed, places)
  return places
}

function collectTurnPlaces(turn: TranscriptTurn, turnAt: number, into: Map<string, FramePlace>): void {
  for (let stepAt = 0; stepAt < turn.steps.length; stepAt += 1) {
    const step = turn.steps[stepAt]
    if (step === undefined) continue
    for (let frameAt = 0; frameAt < step.frames.length; frameAt += 1) {
      const frame = step.frames[frameAt]
      if (frame !== undefined) into.set(frame.frameId, { turn: turnAt, step: stepAt, frame: frameAt })
    }
  }
}

function mergeFrame(frame: TranscriptFrame, overlay: FrameOverlay): TranscriptFrame {
  if (frame.kind === 'text' || frame.kind === 'thinking') {
    if (overlay.text === undefined || overlay.text === frame.text) return frame
    return { ...frame, text: overlay.text }
  }
  if (frame.kind === 'tool') {
    /* 瞬态覆盖带来的入参是流式半成品；它照样是 omp 的那份载荷，收口在帧这一格。 */
    const input = overlay.input === undefined ? frame.input : (overlay.input as OmpToolInputOf)
    const output = overlay.output === undefined ? frame.output : overlay.output
    const progress = overlay.progress === undefined ? frame.progress : overlay.progress
    if (input === frame.input && output === frame.output && progress === frame.progress) return frame
    return { ...frame, input, output, progress }
  }
  return frame
}

/** 把 fold 结果转成线上快照（侧表从状态里的 Map 摊平） */
export function snapshotOf(
  state: ThreadState,
  extras?: {
    readonly hasMoreOlder?: boolean
    readonly outline?: ThreadSnapshot['outline']
  },
): ThreadSnapshot {
  const materialized = materialize(state)
  return {
    items: materialized.items,
    tasks: [...materialized.tasks.values()],
    interactions: [...materialized.interactions.values()],
    attachments: [...materialized.attachments.values()],
    todos: [...materialized.todos.values()],
    prompts: [...materialized.prompts.values()],
    meta: materialized.meta,
    hasMoreOlder: extras?.hasMoreOlder ?? materialized.hasMoreOlder,
    ...(extras?.hasMoreOlder === undefined ? {} : { hasMoreOlder: extras.hasMoreOlder }),
    ...(extras?.outline === undefined ? {} : { outline: extras.outline }),
  }
}

/** 从一页快照建立已提交层（冷读 / 重订阅） */
export function stateFromSnapshot(snapshot: ThreadSnapshot): ThreadState {
  const committed = applyOperation(EMPTY_AGENT_STATE, {
    op: 'reset',
    agentId: 'local',
    snapshot,
  }).state
  const completedItems = new Set<string>()
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue
    for (const step of item.steps) {
      for (const frame of step.frames) {
        /* 还在跑的工具帧继续接受 item.started（那是它的中间结果）；其余帧已经落定 */
        if (frame.kind === 'tool' && frame.state === 'running') continue
        completedItems.add(frame.frameId)
      }
    }
  }
  return { committed, overlay: { frames: new Map(), tasks: new Map() }, completedItems }
}

/** 只保留已提交事件：冷读重建与属性测试都靠它把事件流切成可重放的一段 */
export function committedOnly(events: readonly AgentEvent[]): CommittedAgentEvent[] {
  return events.filter((event): event is CommittedAgentEvent => event.durability === 'committed')
}

/** 侧表里的一条任务；供选择器使用，避免调用方自己遍历 Map */
export function taskOf(state: ThreadState, taskId: string): TranscriptTask | undefined {
  return state.committed.tasks.get(taskId)
}
