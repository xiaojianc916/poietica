import type { TimelineState } from '@poietica/conversation'

export type AssistantActivity =
  | 'thinking'
  | 'receiving'
  | 'working'
  | 'completed'
  | 'failed'
  | 'waiting'
  | 'restoring'
  | 'recalling'
  | 'restricted'
  | 'replying'
  | 'searching'
  | 'stopped'

type ActiveItem = TimelineState['active']['items'][number]

/* 单个进行中条目的活跃类别；静止的条目不给答案。 */
function liveActivityOf(item: ActiveItem): AssistantActivity | undefined {
  switch (item.type) {
    case 'compaction':
      return item.state === 'running' || item.state === 'blocked' ? 'recalling' : undefined
    case 'tool_call':
      if (item.status === 'pending' || item.status === 'in_progress') {
        return item.kind === 'search' || item.kind === 'fetch' ? 'searching' : 'working'
      }
      return undefined
    case 'agent_text':
      return item.sealed ? undefined : 'replying'
    case 'permission':
      return item.resolution === undefined ? 'restricted' : undefined
    case 'question':
      return item.resolution === undefined ? 'waiting' : undefined
    case 'error':
      return 'failed'
    default:
      return undefined
  }
}

function runningActivity(state: TimelineState): AssistantActivity {
  for (let index = state.active.items.length - 1; index >= 0; index -= 1) {
    const item = state.active.items[index]
    if (item === undefined) {
      continue
    }

    const activity = liveActivityOf(item)
    if (activity !== undefined) {
      return activity
    }
  }
  return 'thinking'
}

function unreachable(status: never): never {
  throw new Error(`Unhandled run status: ${String(status)}`)
}

export function assistantActivity(state: TimelineState, restoring: boolean): AssistantActivity {
  if (restoring) {
    return 'restoring'
  }

  switch (state.status) {
    case 'idle':
    case 'awaiting_question':
      return 'waiting'
    case 'submitted':
      return 'receiving'
    case 'running':
      return runningActivity(state)
    case 'awaiting_permission':
      return 'restricted'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelling':
    case 'cancelled':
      return 'stopped'
    default:
      return unreachable(state.status)
  }
}
