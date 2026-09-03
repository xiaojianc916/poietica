import {
  isInFlight,
  type PermissionItem,
  type QuestionTimelineItem,
  type TimelineItem,
  type TimelineState,
  type TodoItem,
} from './timeline-contract'

/** 未结交互以条目为事实；status 只能从条目单向投影，不能反向参与判定。 */
export interface PendingInteractions {
  readonly permission: PermissionItem | undefined
  readonly permissionCount: number
  readonly question: QuestionTimelineItem | undefined
}

const NO_PENDING_INTERACTIONS: PendingInteractions = {
  permission: undefined,
  permissionCount: 0,
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
  let question: QuestionTimelineItem | undefined

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]

    if (item?.type === 'permission' && item.resolution === undefined) {
      permission = item
      permissionCount += 1
      continue
    }

    if (item?.type === 'question' && item.resolution === undefined) {
      question = item
    }
  }

  if (permission === undefined && question === undefined) {
    return NO_PENDING_INTERACTIONS
  }

  return { permission, permissionCount, question }
}

/** 一次状态过滤、一次扫描，交出输入区需要的完整交互快照。 */
export function pendingInteractions(scope: WaitingScope): PendingInteractions {
  if (scope.status !== 'awaiting_permission' && scope.status !== 'awaiting_question') {
    return NO_PENDING_INTERACTIONS
  }

  const found = scanPending(scope.items)
  if (scope.status === 'awaiting_question') {
    return found.question === undefined
      ? NO_PENDING_INTERACTIONS
      : { permission: undefined, permissionCount: 0, question: found.question }
  }

  return found
}

/** 终态中的旧条目不可再操作；活动态只展示最高优先级的审批。 */
export function pendingPermission(scope: WaitingScope): PermissionItem | undefined {
  return pendingInteractions(scope).permission
}

export function pendingPermissionCount(scope: WaitingScope): number {
  return pendingInteractions(scope).permissionCount
}

/** 审批和题组并存时题组仍保留，但终态中的题组不再可操作。 */
export function pendingQuestion(scope: WaitingScope): QuestionTimelineItem | undefined {
  return pendingInteractions(scope).question
}

export function currentTodos(state: TimelineState): readonly TodoItem[] | null {
  const pages = [...state.sealed, state.active]
  for (let pageIndex = pages.length - 1; pageIndex >= 0; pageIndex -= 1) {
    const page = pages[pageIndex]
    if (page === undefined) {
      continue
    }
    for (let itemIndex = page.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = page.items[itemIndex]
      if (item?.type !== 'tool_call' || item.kind !== 'todo' || item.status === 'failed') {
        continue
      }
      const isLivePreview = item.turn === state.active.turn && selectIsBusy(state)
      if (item.status !== 'completed' && !isLivePreview) {
        continue
      }
      const snapshot = item.requestContent.find((content) => content.type === 'todo')
      if (snapshot !== undefined) {
        return snapshot.items
      }
    }
  }
  return null
}

export function selectIsBusy(state: TimelineState): boolean {
  return isInFlight(state.status)
}

/**
 * kap 手上那条还没落定的号。
 *
 * 出账簿一次只放一条出去，所以它至多一个 —— 单值，引用天生稳定，不需要缓存。
 */
export function inflightPromptId(scope: WaitingScope): string | undefined {
  for (let index = scope.items.length - 1; index >= 0; index -= 1) {
    const item = scope.items[index]

    if (item?.type === 'inflight_prompt' && item.settled === undefined) {
      return item.promptId
    }
  }

  return undefined
}
