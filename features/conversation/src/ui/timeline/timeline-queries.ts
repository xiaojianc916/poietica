import {
  isInFlight,
  type PermissionItem,
  type PlanItem,
  type QuestionTimelineItem,
  type TimelineItem,
  type TimelineState,
  type ToolCallTimelineItem,
} from '../shared/timeline/timeline-contract'
import { sealedPageMemo } from './page-memo'

/** 未结交互以条目为事实；status 只能从条目单向投影，不能反向参与判定。 */
export interface PendingInteractions {
  readonly permission: PermissionItem | undefined
  readonly permissionCount: number
  readonly plan: PlanItem | undefined
  readonly question: QuestionTimelineItem | undefined
}

const NO_PENDING_INTERACTIONS: PendingInteractions = {
  permission: undefined,
  permissionCount: 0,
  plan: undefined,
  question: undefined,
}

export interface WaitingScope {
  readonly items: readonly TimelineItem[]
  readonly status: TimelineState['status']
}

export function activeScope(state: TimelineState): WaitingScope {
  return { items: state.active.items, status: state.status }
}

/** 一次扫描给出最早的未结审批、审批总数和最早的未结题组。不设状态闸：reducer 由它派生 status。 */
export function scanPending(items: readonly TimelineItem[]): PendingInteractions {
  let permission: PermissionItem | undefined
  let permissionCount = 0
  let plan: PlanItem | undefined
  let question: QuestionTimelineItem | undefined

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]

    if (item?.type === 'plan' && item.resolution === undefined) {
      plan = item
      continue
    }

    if (item?.type === 'permission' && item.resolution === undefined) {
      permission = item
      permissionCount += 1
      continue
    }

    if (item?.type === 'question' && item.resolution === undefined) {
      question = item
    }
  }

  if (permission === undefined && plan === undefined && question === undefined) {
    return NO_PENDING_INTERACTIONS
  }

  return { permission, permissionCount, plan, question }
}

export function pendingInteractions(scope: WaitingScope): PendingInteractions {
  if (
    scope.status !== 'awaiting_permission' &&
    scope.status !== 'awaiting_question' &&
    scope.status !== 'awaiting_plan'
  ) {
    return NO_PENDING_INTERACTIONS
  }

  const found = scanPending(scope.items)
  if (scope.status === 'awaiting_plan') {
    return found.plan === undefined ? NO_PENDING_INTERACTIONS : { ...found, permission: undefined, question: undefined }
  }
  if (scope.status === 'awaiting_question') {
    return found.question === undefined
      ? NO_PENDING_INTERACTIONS
      : { permission: undefined, permissionCount: 0, plan: undefined, question: found.question }
  }

  return found
}

const NO_STAMPS: readonly string[] = []

function clientTurnIdsIn(items: readonly TimelineItem[]): readonly string[] {
  let stamps: string[] | undefined
  for (const item of items) {
    if (item.type === 'user_message' && item.clientTurnId !== undefined && item.clientTurnId !== '') {
      stamps ??= []
      stamps.push(item.clientTurnId)
    }
  }
  return stamps ?? NO_STAMPS
}

const sealedStampsOf = sealedPageMemo((page) => clientTurnIdsIn(page.items))

/**
 * 时间线里此刻已有的真实 turn 号（`clientTurnId`）。判据是**真实 turn 已经画得出来**：投影里那一轮带上了提交号才算「换过了」；
 * 每次写格子都要问一遍，所以已封口的页按页记账，只有在跑那一页现扫。
 */
export function clientTurnIdsOf(state: Pick<TimelineState, 'sealed' | 'active'>): ReadonlySet<string> {
  const stamped = new Set<string>()
  for (const page of state.sealed) {
    for (const id of sealedStampsOf(page)) stamped.add(id)
  }
  for (const id of clientTurnIdsIn(state.active.items)) stamped.add(id)
  return stamped
}

/** 时间线上的 delegate 调用：结清的计数并按出现顺序留着（状态面板「已结束」展开后要画、要点得开），还在跑的按出现顺序交回。 */
export interface DelegateCalls {
  readonly ended: number
  readonly finished: readonly ToolCallTimelineItem[]
  readonly running: readonly ToolCallTimelineItem[]
}

const NO_DELEGATES: DelegateCalls = { ended: 0, finished: [], running: [] }

function delegateCallsIn(items: readonly TimelineItem[]): DelegateCalls {
  let finished: ToolCallTimelineItem[] | undefined
  let running: ToolCallTimelineItem[] | undefined
  for (const item of items) {
    if (item.type !== 'tool_call' || item.kind !== 'delegate') {
      continue
    }
    if (item.status === 'in_progress' || item.status === 'pending') {
      running ??= []
      running.push(item)
    } else {
      finished ??= []
      finished.push(item)
    }
  }
  return finished === undefined && running === undefined
    ? NO_DELEGATES
    : { ended: finished?.length ?? 0, finished: finished ?? [], running: running ?? [] }
}

const sealedDelegatesOf = sealedPageMemo((page) => delegateCallsIn(page.items))

/** 这条时间轴上全部 delegate 调用（任务面板「智能体」那一节）。面板随时间线每帧重算，长对话里逐条扫一遍是每帧固定开销，所以已封口页按页记账。 */
export function delegateCallsOf(state: Pick<TimelineState, 'sealed' | 'active'>): DelegateCalls {
  const finished: ToolCallTimelineItem[] = []
  const running: ToolCallTimelineItem[] = []
  for (const part of [...state.sealed.map(sealedDelegatesOf), delegateCallsIn(state.active.items)]) {
    finished.push(...part.finished)
    running.push(...part.running)
  }
  return { ended: finished.length, finished, running }
}

export function selectIsBusy(state: TimelineState): boolean {
  return isInFlight(state.status)
}
