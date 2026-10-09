import type { TimelineState, TranscriptFrame } from '@poietica/transcript'
import { LiveProjector } from '../../live'

/** 投影器共用的时钟：所有断言都在同一个时刻上，快照才不会随运行时间变 */
export const T0 = 1_700_000_000_000

export const projector = (): LiveProjector => new LiveProjector({ now: () => T0 })

export const iso = (ms: number): string => new Date(ms).toISOString()

/** 三个屏幕读法：助手正文、思维链、工具行（live.test.ts 与 live-legacy.test.ts 共用） */
export function snapshot(state: TimelineState): { texts: string[]; thoughts: string[]; tools: string[] } {
  const texts: string[] = []
  const thoughts: string[] = []
  const tools: string[] = []
  for (const item of state.items) {
    if (item.kind !== 'turn') continue
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'text' && frame.role === 'assistant') texts.push(frame.text)
        else if (frame.kind === 'thinking') thoughts.push(frame.text)
        else if (frame.kind === 'tool') tools.push(`${frame.name}:${frame.state}:${String(frame.output ?? '')}`)
      }
    }
  }
  return { texts, thoughts, tools }
}

/** 一个 step 里的帧，按屏幕顺序摊平（legacy settle() 里那个 turn(id) 读法的展开） */
export function framesOf(state: TimelineState): readonly TranscriptFrame[] {
  return state.items.flatMap((item) => (item.kind === 'turn' ? item.steps.flatMap((s) => s.frames) : []))
}
