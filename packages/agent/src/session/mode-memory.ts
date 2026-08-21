import { createPreference, type PreferenceFailure } from '@poietica/core'
import * as v from 'valibot'

/*
 * 模式在两次运行之间的落脚处。
 *
 * 真相仍是 TranscriptStore 的 modes：这里只被写、以及在打开一条对话时被读一次。
 * 实现走全仓唯一那条偏好管线，实例由组合根造出来交进 store。
 */

import { NO_MODES, type RunMode } from './run-mode'

export interface ModeMemory {
  readonly read: (threadId: string) => RunMode
  readonly write: (threadId: string, modes: RunMode) => void
}

const KEY = 'poietica.thread-modes'

const KEPT = v.record(v.string(), v.array(v.string()))

type Kept = Readonly<Record<string, readonly string[]>>

const NONE: Kept = {}

/** 落盘的是开着的那几档的名字：认不出的名字一律当没开。 */
function modesOf(names: readonly string[]): RunMode {
  return { goal: names.includes('goal'), swarm: names.includes('swarm') }
}

function namesOf(modes: RunMode): readonly string[] {
  return (['goal', 'swarm'] as const).filter((name) => modes[name])
}

/** 存坏了不吞：解码交给校验器，失败走调用方的上报通道并回落到空表。 */
export function createModeMemory(onFailure: (failure: PreferenceFailure) => void): ModeMemory {
  const kept = createPreference<Kept>({
    key: KEY,
    fallback: NONE,
    decode: (raw): Kept => v.parse(KEPT, JSON.parse(raw)),
    encode: (value) => (Object.keys(value).length === 0 ? null : JSON.stringify(value)),
    onFailure,
  })

  return {
    read: (threadId) => {
      const names = kept.read()[threadId]

      return names === undefined ? NO_MODES : modesOf(names)
    },

    write: (threadId, modes) => {
      const next: Record<string, readonly string[]> = { ...kept.read() }
      const names = namesOf(modes)

      if (names.length === 0) {
        delete next[threadId]
      } else {
        next[threadId] = names
      }

      kept.write(next)
    },
  }
}
