import type { TimelineState } from '@poietica/conversation'

export type AgentEmotionId =
  | '30'
  | '31'
  | '32'
  | '33'
  | '34'
  | '35'
  | '36'
  | '37'
  | '38'
  | '39'
  | '40'
  | '41'

export const AGENT_EMOTION_LABELS: Readonly<Record<AgentEmotionId, string>> = {
  '30': '思考中',
  '31': '接收任务',
  '32': '处理中',
  '33': '任务完成',
  '34': '出错',
  '35': '等待输入',
  '36': '联网加载',
  '37': '复述回忆',
  '38': '等待授权',
  '39': '输出回复',
  '40': '检索资料',
  '41': '停止任务',
}

function activeEmotion(state: TimelineState): AgentEmotionId {
  for (let index = state.active.items.length - 1; index >= 0; index -= 1) {
    const item = state.active.items[index]

    if (item === undefined) {
      continue
    }

    switch (item.type) {
      case 'compaction':
        if (item.state === 'running' || item.state === 'blocked') {
          return '37'
        }
        break
      case 'tool_call':
        if (item.status === 'pending' || item.status === 'in_progress') {
          return item.kind === 'search' || item.kind === 'fetch' ? '40' : '32'
        }
        break
      case 'agent_text':
        if (!item.sealed) {
          return '39'
        }
        break
      case 'permission':
        if (item.resolution === undefined) {
          return '38'
        }
        break
      case 'question':
        if (item.resolution === undefined) {
          return '35'
        }
        break
      case 'error':
        return '34'
      default:
        break
    }
  }

  return '30'
}

function unreachable(value: never): never {
  throw new Error(`Unhandled run status: ${String(value)}`)
}

export function agentEmotionId(state: TimelineState, restoring: boolean): AgentEmotionId {
  if (restoring) {
    return '36'
  }

  switch (state.status) {
    case 'idle':
    case 'awaiting_question':
      return '35'
    case 'submitted':
      return '31'
    case 'running':
      return activeEmotion(state)
    case 'awaiting_permission':
      return '38'
    case 'completed':
      return '33'
    case 'failed':
      return '34'
    case 'cancelling':
    case 'cancelled':
      return '41'
    default:
      return unreachable(state.status)
  }
}
