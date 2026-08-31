import { expect, test } from 'bun:test'
import { applyRunEvents, replayThreadEvents, selectPresentation } from '@poietica/conversation'
import { closedConversation, liveDelta, liveTurn } from './synthetic-conversation'

/*
 * 打开一条会话、再让它吐字的基准。
 *
 * 只报数字，不设时限：共享跑机上的毫秒不是正确性契约。派生结果的引用稳定性是
 * 契约，它在 packages/conversation 的 presentation-stability 里断言。
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
  readonly msPerFrame: number
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

  const streamedAt = performance.now()

  for (let frame = 0; frame < FRAMES; frame += 1) {
    state = applyRunEvents(state, [
      liveDelta(LIVE_SEQ + 1 + frame, 9_000_100 + frame, frame, SHAPE.width),
    ])

    selectPresentation(state, CLOSED).rowAt(0)
  }

  const msPerFrame = (performance.now() - streamedAt) / FRAMES

  return {
    turns,
    openMs: round(openMs),
    rows: opened.count,
    msPerFrame: round(msPerFrame),
  }
}

test('打开超长会话并吐字，基准跑通并报出每帧代价', () => {
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

  /* 基准自己要成立的那一条：规模更大的那次条目更多。 */
  expect(small.rows).toBeGreaterThan(0)
  expect(large.rows).toBeGreaterThan(small.rows)
})
