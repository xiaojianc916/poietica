import { expect, test } from 'bun:test'
import { applyRunEvents, replayThreadEvents, selectPresentation } from '@poietica/agent'
import { closedConversation, liveDelta, liveTurn } from './synthetic-conversation'

/*
 * 打开一条会话、再让它吐字，代价必须与会话有多长无关。
 *
 * 断言不写毫秒：机器快慢不是正确性契约。写的是两件与机器无关的事 —— 派生结果在一帧
 * 之间的引用稳定性（下游的记忆化全靠它），以及每帧代价随轮次增长的倍率上界。
 * 毫秒只报告，不断言。
 */

/* 开合表跨帧同一份：投影按它的身份判「人点过没有」。 */
const CLOSED: ReadonlyMap<number, boolean> = new Map()

const SHAPE = { deltas: 3, toolEvery: 5, width: 480 }
const FRAMES = 40
const LIVE_SEQ = 1_000_000

interface Sample {
  readonly turns: number
  readonly openMs: number
  readonly rows: number
  readonly railEntries: number
  readonly msPerFrame: number
  readonly railStable: boolean
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function sample(turns: number): Sample {
  const history = closedConversation({ ...SHAPE, turns })
  const openedAt = performance.now()
  let state = replayThreadEvents(history)
  const opened = selectPresentation(state, CLOSED)
  const openMs = performance.now() - openedAt

  state = applyRunEvents(state, [liveTurn(LIVE_SEQ, 9_000_000)])

  let rail = selectPresentation(state, CLOSED).turns
  let stable = true
  const streamedAt = performance.now()

  for (let frame = 0; frame < FRAMES; frame += 1) {
    state = applyRunEvents(state, [
      liveDelta(LIVE_SEQ + 1 + frame, 9_000_100 + frame, frame, SHAPE.width),
    ])

    const next = selectPresentation(state, CLOSED).turns

    /* 头两帧回复摘要还在长（PREVIEW 之内），之后它逐字不变，轮次表因此必须同引用。 */
    if (frame > 1) {
      stable = stable && Object.is(next, rail)
    }

    rail = next
  }

  const msPerFrame = (performance.now() - streamedAt) / FRAMES

  return {
    turns,
    openMs: round(openMs),
    rows: opened.count,
    railEntries: rail.length,
    msPerFrame: round(msPerFrame),
    railStable: stable,
  }
}

test('打开超长会话并吐字，每帧代价与会话长度无关', () => {
  /* 预热一次，不让 JIT 与 GC 的第一次代价落在被测的那两次上。 */
  sample(16)

  const small = sample(125)
  const large = sample(1_000)

  console.log(
    'POIETICA_PERF_RESULT ' +
      JSON.stringify(
        {
          shape: { ...SHAPE, frames: FRAMES },
          samples: [small, large],
          frameCostRatio: round(large.msPerFrame / small.msPerFrame),
        },
        null,
        2,
      ),
  )

  expect(small.rows).toBeGreaterThan(0)
  expect(large.rows).toBeGreaterThan(small.rows)
  expect(large.railEntries).toBe(large.turns + 1)

  /* 派生结果引用稳定 —— 下游的记忆化全靠它，这一条与机器快慢无关。 */
  expect(small.railStable).toBe(true)
  expect(large.railStable).toBe(true)

  /* 每帧代价的倍率：轮次差八倍，代价不许跟着走。 */
  expect(large.msPerFrame / small.msPerFrame).toBeLessThan(4)
})
