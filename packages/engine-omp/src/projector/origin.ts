import type { TranscriptTurn } from '@poietica/transcript'

export type TurnOrigin = TranscriptTurn['origin']

/**
 * 目标续跑轮的来源：系统自己触发、自开一轮的 `other`。
 * 实时投影与历史投影共用这一个常量，两条路径的轮头才会一致（同一会话关掉重开，轮头不变）。
 */
export const GOAL_CONTINUATION_ORIGIN: TurnOrigin = { kind: 'other', trigger: 'goal_continuation' }

/** 人话那一轮：点了技能就带上 chip（技能名），否则就是一个光秃秃的 `user`。 */
export function userOrigin(skills: readonly string[]): TurnOrigin {
  return skills.length === 0
    ? { kind: 'user' }
    : { kind: 'user', skillActivations: skills.map((skillName) => ({ skillName })) }
}
