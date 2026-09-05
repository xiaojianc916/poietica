import type { RunStatus } from '../agent'
import type { ErrorItem, TimelineState, TurnPage } from './timeline-contract'

export function createTimelineState(): TimelineState {
  return {
    status: 'idle',
    backgroundTasks: [],
    sealed: [],
    active: { turn: 0, items: [] },
    lastSeq: 0,
    spans: [],
  }
}
function replaceActive(state: TimelineState, active: TurnPage, status: RunStatus): TimelineState {
  return { ...state, active, status }
}
export function appendUserMessage(
  state: TimelineState,
  text: string,
  at: number,
  carrying = 0,
  attached: readonly string[] = [],
): TimelineState {
  const said = text.trim()
  if (said.length === 0 && carrying === 0) {
    return state
  }
  const item = {
    type: 'user_message' as const,
    id: `local:${String(at)}:${String(state.active.items.length)}`,
    turn: state.active.turn,
    at,
    text: said,
    ...(attached.length === 0 ? {} : { skills: attached }),
  }
  return replaceActive(
    state,
    { ...state.active, items: [...state.active.items, item] },
    'submitted',
  )
}
export function appendLocalError(
  state: TimelineState,
  error: { readonly message: string; readonly at: number; readonly endsTurn: boolean },
): TimelineState {
  const item: ErrorItem = {
    type: 'error',
    id: `local-error:${String(error.at)}:${String(state.active.items.length)}`,
    turn: state.active.turn,
    at: error.at,
    message: error.message,
  }
  return replaceActive(
    state,
    { ...state.active, items: [...state.active.items, item] },
    error.endsTurn ? 'failed' : state.status,
  )
}
export function requestRunCancellation(state: TimelineState): TimelineState {
  return state.status === 'running' ||
    state.status === 'submitted' ||
    state.status === 'awaiting_permission' ||
    state.status === 'awaiting_question'
    ? { ...state, status: 'cancelling' }
    : state
}
export function rejectRunCancellation(state: TimelineState): TimelineState {
  return state.status === 'cancelling' ? { ...state, status: 'running' } : state
}
export function confirmRunCancellation(state: TimelineState, _at: number): TimelineState {
  return { ...state, status: 'cancelled' }
}
