import type { TimelineState } from './timeline-contract'

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
