import type { TranscriptTurn } from '@poietica/transcript'

export type TurnOrigin = TranscriptTurn['origin']

/**
 * 目标续跑轮的来源。照 transcript upstream `history/groupTurns.ts` 的约定：
 * `system_trigger/goal_continuation` 自开一轮（`opensOwnTurn`），且 `mapOrigin` 把未知来源落成 `{ kind: 'other', payload }`。
 * 实时投影与历史投影共用这一个常量，两条路径的轮头才会一致（同一会话关掉重开，轮头不变）。
 */
export const GOAL_CONTINUATION_ORIGIN: TurnOrigin = {
  kind: 'other',
  payload: { kind: 'system_trigger', name: 'goal_continuation' },
}
