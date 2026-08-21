import { createPreference, type PreferenceFailure } from '@poietica/core'
import * as v from 'valibot'

/*
 * 目标在两次运行之间的落脚处。
 *
 * 真相仍是 TranscriptStore 的 modes：这里只被写、以及在打开一条对话时被读一次。
 * 实现走全仓唯一那条偏好管线，实例由组合根造出来交进 store。
 */

export interface GoalMemory {
  readonly read: (threadId: string) => string | null
  readonly write: (threadId: string, goal: string | null) => void
}

const KEY = 'poietica.thread-goals'

const GOALS = v.record(v.string(), v.string())

type Goals = Readonly<Record<string, string>>

const NONE: Goals = {}

/** 存坏了不吞：解码交给校验器，失败走调用方的上报通道并回落到空表。 */
export function createGoalMemory(onFailure: (failure: PreferenceFailure) => void): GoalMemory {
  const kept = createPreference<Goals>({
    key: KEY,
    fallback: NONE,
    decode: (raw): Goals => v.parse(GOALS, JSON.parse(raw)),
    encode: (value) => (Object.keys(value).length === 0 ? null : JSON.stringify(value)),
    onFailure,
  })

  return {
    read: (threadId) => kept.read()[threadId] ?? null,

    write: (threadId, goal) => {
      const next: Record<string, string> = { ...kept.read() }

      if (goal === null) {
        delete next[threadId]
      } else {
        next[threadId] = goal
      }

      kept.write(next)
    },
  }
}
