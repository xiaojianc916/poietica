import { describe, expect, it } from 'bun:test'
import {
  applyRunEvents,
  type RunEvent,
  replayThreadEvents,
  selectIsBusy,
  selectPresentation,
  type TimelineState,
} from '@poietica/conversation'
import { closedConversation, liveDelta, liveTurn } from '../perf/synthetic-conversation'

/*
 * 实时 ≡ 重放（计划 §3.5：投影是纯函数，实时与重启重放必须逐字等价）。
 *
 * 屏幕那一侧与重开那一侧是两份代码：按拍攒帧走 applyRunEvents 增量折叠，
 * 重开一条对话走 replayThreadEvents 一次成型。这里把同一份收口经过喂给两条
 * 路，断言得到的转录逐字相同 —— 分叉的那天，重开的对话就不再是关闭前的那
 * 一条，而那是无法测试的状态空间（见计划的公理 1）。
 */

/* 开合表跨帧同一份：投影按它的身份判「人点过没有」。 */
const CLOSED: ReadonlyMap<number, boolean> = new Map()

/*
 * 分批的边界画成不规则的：等价不许依赖恰好整轮成批。
 */
const BATCH_SIZES = [1, 3, 2, 7, 1, 4] as const

function foldInBatches(events: readonly RunEvent[]): TimelineState {
  let state = replayThreadEvents([])
  let at = 0

  while (at < events.length) {
    const size = BATCH_SIZES[at % BATCH_SIZES.length] ?? 1
    state = applyRunEvents(state, events.slice(at, at + size))
    at += size
  }

  return state
}

describe('实时 ≡ 重放', () => {
  it('同一份收口经过，按拍折叠与一次重放逐字相同', () => {
    const history = closedConversation({ deltas: 3, toolEvery: 5, turns: 12, width: 480 })

    const live = foldInBatches(history)
    const reopened = replayThreadEvents(history)

    expect(live).toEqual(reopened)

    /* 等价不是两份空白相等：屏幕读的那一份条数一致且非空。 */
    const onScreen = selectPresentation(live, CLOSED).count
    expect(onScreen).toBe(selectPresentation(reopened, CLOSED).count)
    expect(onScreen).toBeGreaterThan(0)
  })

  it('轮数变多等价仍然成立：段号与条目身份不随规模漂移', () => {
    const history = closedConversation({ deltas: 2, toolEvery: 3, turns: 40, width: 200 })

    expect(foldInBatches(history)).toEqual(replayThreadEvents(history))
  })

  /*
   * 等价的边界要说清：一条没走到终局的经过，重放把它判为失败（fill 的收口），
   * 实时流无从知道日志已经断尾。这不是缺陷，是两条路各自知道的事不同 —— 把
   * 它钉在这里，防止哪天有人把任何一侧「修」成另一侧。
   */
  it('断尾的经过：重放判为失败，实时流仍在跑', () => {
    const interrupted = [liveTurn(1, 100), liveDelta(2, 110, 0, 480)]

    const live = applyRunEvents(replayThreadEvents([]), interrupted)
    const reopened = replayThreadEvents(interrupted)

    expect(selectIsBusy(live)).toBe(true)
    expect(reopened.status).toBe('failed')
    expect(selectIsBusy(reopened)).toBe(false)
  })
})
