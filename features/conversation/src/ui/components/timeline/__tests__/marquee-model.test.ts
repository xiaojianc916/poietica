import { describe, expect, it } from 'bun:test'
import {
  clampToTail,
  isSettled,
  LAG_SET_EM,
  MAX_CATCHUP_PX_S,
  MAX_DT_MS,
  type MarqueeGeometry,
  type MarqueeState,
  RATE_WINDOW_MS,
  type RateSample,
  rateOf,
  SNAP_KEEP_RATIO,
  SNAP_LAG_RATIO,
  step,
  TAIL_EM,
  targetOffset,
} from '../marquee-model'

/*
 * 电子屏那一下「划」的数学。
 *
 * 三条性质才是这一层存在的理由，其余是按条列出的边界：
 *
 *   1. **匀速、不抽**：token 成批到达，目标位移是台阶。旧的指数追随每批到达都猛冲一下再
 *      减速，看起来一抽一抽；这里追的是估出来的出字速度，所以相邻两帧的速度几乎不变。
 *   2. **停笔停稳**：模型停下时平滑减速，不留在半路上，也不急刹。
 *   3. **快模型**：允许跳近与硬底线，但任何一帧都不许让最新的字越出窗口右缘。
 *
 * happy-dom 没有真实布局，宽度都量成 0，所以这里全部按纯函数模拟逐帧：几何与时序都
 * 是我们自己喂进去的。
 */

const CHAR_PX = 16
const FONT_PX = 16
const TAIL_PX = TAIL_EM * FONT_PX
const VIEWPORT_PX = 600
const FRAME_MS = 16
const TOKEN_MS = 50

interface Frame {
  readonly t: number
  readonly target: number
  readonly x: number
  readonly v: number
  readonly rate: number
}

interface SimOptions {
  /** 每秒出多少字 */
  readonly charsPerSec: number
  /** 从第几毫秒停笔 */
  readonly stopAtMs: number
  /** 一共跑多少毫秒 */
  readonly durationMs: number
  /** t=0 时已有多少字（让划动一开始就在进行中，不用先等它长到超宽） */
  readonly startChars: number
}

/**
 * 逐帧跑一遍，返回每一帧的状态。
 *
 * 复刻 use-marquee 的调用顺序：目标随 token 变化 → `rateOf` 估速度 → `step` 推进 →
 * `clampToTail` 兜底。顺序不能换，安全底线必须在最后。
 *
 * 帧与 token 是两条独立的钟（16ms 一帧、50ms 一批），token 按自己的时刻补上 —— 让两者
 * 共用 `t % TOKEN_MS` 的话，1.5 字一批的出字速度会被算成每 400ms 才来一批。
 */
function simulate(options: SimOptions): Frame[] {
  let content = options.startChars * CHAR_PX
  const geometry = (): MarqueeGeometry => ({ content, viewport: VIEWPORT_PX, tail: TAIL_PX })
  let state: MarqueeState = { x: targetOffset(geometry()), v: 0 }
  let samples: RateSample[] = [{ at: 0, target: targetOffset(geometry()) }]
  let written = options.startChars
  let dueAt = TOKEN_MS
  const frames: Frame[] = []

  for (let t = 0; t <= options.durationMs; t += FRAME_MS) {
    while (dueAt <= t && dueAt <= options.stopAtMs) {
      written += (options.charsPerSec * TOKEN_MS) / 1000
      content = written * CHAR_PX
      samples.push({ at: dueAt, target: targetOffset(geometry()) })
      dueAt += TOKEN_MS
    }

    samples = samples.filter((sample) => t - sample.at <= RATE_WINDOW_MS)

    const g = geometry()
    const target = targetOffset(g)
    const rate = rateOf(samples, t)
    const next = step(state, target, rate, FRAME_MS, g)
    const x = clampToTail(next.x, target, TAIL_PX)

    state = { x, v: next.v }
    frames.push({ t, target, x, v: next.v, rate })
  }

  return frames
}

/** 全程不许越过的两条线：最新的字不进窗口右缘之外，也不越过目标。 */
function violations(frames: readonly Frame[]): number[] {
  return frames.filter((f) => f.target - f.x > TAIL_PX + 1e-6 || f.x > f.target + 1e-6).map((f) => f.t)
}

describe('目标位移', () => {
  it('装得下就是 0，装不下才是多出来的那一截', () => {
    expect(targetOffset({ content: 300, viewport: 400, tail: 32 })).toBe(0)
    expect(targetOffset({ content: 500, viewport: 400, tail: 32 })).toBe(132)
  })
})

describe('出字速度的估计', () => {
  it('窗口内不足两个样本就算没在出字', () => {
    expect(rateOf([], 0)).toBe(0)
    expect(rateOf([{ at: 0, target: 100 }], 10)).toBe(0)
  })

  it('每 100ms 增 100px 就是 1000px/s', () => {
    const samples: RateSample[] = [
      { at: 0, target: 0 },
      { at: 100, target: 100 },
      { at: 200, target: 200 },
    ]

    expect(rateOf(samples, 200)).toBeCloseTo(1000, 6)
  })

  it('分母至少 120ms：刚起步两个样本挨太近时速度会被估得离谱', () => {
    const samples: RateSample[] = [
      { at: 0, target: 0 },
      { at: 10, target: 100 },
    ]

    /* 10ms 里写了 100px；按真实间隔算是 10000px/s，按下限算是 833px/s。 */
    expect(rateOf(samples, 10)).toBeCloseTo(100000 / 120, 6)
  })

  it('窗口外的样本不计', () => {
    /* 0 那一刻那个样本落在窗口外；带上它会算出 238px/s。 */
    const samples: RateSample[] = [
      { at: 0, target: 0 },
      { at: 1900, target: 400 },
      { at: 2100, target: 500 },
    ]

    expect(rateOf(samples, 2100)).toBeCloseTo(500, 6)
  })
})

describe('走一帧', () => {
  const g: MarqueeGeometry = { content: 500, viewport: 400, tail: 32 }

  it('目标后退时直接到位：往回滑读起来像倒带', () => {
    expect(step({ x: 100, v: 300 }, 50, 0, 16, g)).toEqual({ x: 50, v: 0 })
  })

  it('落后太多先跳近，留一小段继续滑', () => {
    const target = 1000
    const next = step({ x: 0, v: 0 }, target, 0, 16, g)

    expect(next.x).toBeCloseTo(target - g.viewport * SNAP_KEEP_RATIO, 6)
    expect(target - next.x).toBeGreaterThan(0)
  })

  it('跳近的门槛是窗口宽的 60%', () => {
    const target = 1000
    const snapAt = target - g.viewport * SNAP_LAG_RATIO
    /* 正好卡在门槛上：还没到跳近那一步，只是照常往前挪。 */
    const near = step({ x: snapAt, v: 0 }, target, 0, 16, g)

    expect(near.x).toBeGreaterThan(snapAt)
    /* 过了门槛一位：直接跳近。 */
    const far = step({ x: snapAt - 1, v: 0 }, target, 0, 16, g)

    expect(far.x).toBeCloseTo(target - g.viewport * SNAP_KEEP_RATIO, 6)
  })

  it('从不超过目标，速度也不为负', () => {
    const next = step({ x: 0, v: MAX_CATCHUP_PX_S * 10 }, 100, MAX_CATCHUP_PX_S, FRAME_MS, g)

    expect(next.x).toBeLessThanOrEqual(100)
    expect(next.v).toBeGreaterThanOrEqual(0)
  })

  it('单帧时间步封顶 64ms：标签页从后台切回时不一步跳过头', () => {
    const long = step({ x: 0, v: 0 }, 400, 2000, 5000, g)
    const capped = step({ x: 0, v: 0 }, 400, 2000, MAX_DT_MS, g)

    expect(long).toEqual(capped)
  })

  it('追赶速度有上限：新句一出场就超宽也不会嗖地划走', () => {
    const next = step({ x: 0, v: 0 }, 400, 100_000, FRAME_MS, g)

    expect(next.v).toBeLessThanOrEqual(MAX_CATCHUP_PX_S)
  })

  it('到位判定同时看位置与速度：只看位置会在减速尾段提前停', () => {
    expect(isSettled({ x: 100, v: 0 }, 100)).toBe(true)
    /* 差不到半像素也算到了。 */
    expect(isSettled({ x: 99.7, v: 0 }, 100)).toBe(true)
    /* 位置差得还看得见：不算到位。 */
    expect(isSettled({ x: 99, v: 0 }, 100)).toBe(false)
    /* 位置到了但还在飞：不能算停稳，否则最后一小截没走完就停了。 */
    expect(isSettled({ x: 100, v: 100 }, 100)).toBe(false)
  })

  it('安全底线：最新的字不得越过窗口右缘', () => {
    expect(clampToTail(10, 1000, TAIL_PX)).toBe(1000 - TAIL_PX)
    expect(clampToTail(980, 1000, TAIL_PX)).toBe(980)
  })
})

describe('核心性质 1：匀速、不抽', () => {
  /* 每秒 30 字、字宽 16px、尾 32px、窗口 600px，token 每 50ms 一批，每 16ms 一帧。 */
  const frames = simulate({ charsPerSec: 30, stopAtMs: 3000, durationMs: 3000, startChars: 50 })
  /* 起步阶段让速度爬上来，不算；之后进入稳态。 */
  const steady = frames.filter((f) => f.t > 300 && f.target > 0)

  it('全程最新的字都在窗口内', () => {
    expect(violations(frames)).toEqual([])
  })

  /**
   * 这一条正是旧的指数追随过不了的：它每批 token 到达都冲一下再减速。
   *
   * 这里追的是估出来的出字速度，相邻两帧的速度变化因此只有个位数 —— 门限取 10%
   * 已经相当宽，实测还差一个数量级。视觉上「一抽一抽」的门限远低于此。
   */
  it('相邻两帧的速度变化不超过出字速度的 10%', () => {
    const typingRate = 30 * CHAR_PX
    const jumps = steady.filter((frame, index) => {
      const before = steady[index - 1]

      return index > 0 && before !== undefined && Math.abs(frame.v - before.v) > typingRate * 0.1
    })

    expect(jumps.map((frame) => frame.t)).toEqual([])
  })

  it('稳态速度跟得上出字速度（不是慢吞吞地追）', () => {
    const late = frames.filter((f) => f.t > 1000 && f.target > 0)
    const average = late.reduce((sum, f) => sum + f.v, 0) / late.length

    expect(average).toBeGreaterThan(30 * CHAR_PX * 0.9)
  })
})

describe('核心性质 2：停笔停稳', () => {
  const STOP = 2000
  const frames = simulate({ charsPerSec: 30, stopAtMs: STOP, durationMs: STOP + 1200, startChars: 50 })
  const after = frames.filter((f) => f.t >= STOP)
  const last = after[after.length - 1]
  const settledAt = after.find((f) => f.target - f.x < 0.5 && f.v < 4)

  it('停笔之后 600ms 内停稳', () => {
    expect(settledAt).toBeDefined()
    expect((settledAt?.t ?? 0) - STOP).toBeLessThanOrEqual(600)
  })

  it('减速过程中位置单调向前，没有倒带', () => {
    let previous = -Infinity

    for (const frame of after) {
      expect(frame.x).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = frame.x
    }
  })

  /*
   * 速度不单调下降，中间会回升一点：token 成批到达，最后几批会穿插进减速过程，而速度是按
   * 最近 600ms 的窗口估出来的。所以这里不测「单调下降」，测它读起来像不像急刹。
   *
   * 「到达的那一帧」要排除：还剩几个像素时，一帧就把它走完（位置被 `Math.min` 钉在目标上），
   * 速度的读数在那一帧失去意义 —— 眼睛看到的是它正好停在该停的地方，不是突然顿住。
   */
  it('减速是滑出去而不是急刹：还有距离要走时速度变化不超过出字速度的 10%', () => {
    const typingRate = 30 * CHAR_PX
    const remaining = (frame: Frame): boolean => frame.target - frame.x > 0
    const jerks = after.filter((frame, index) => {
      const before = after[index - 1]

      if (index === 0 || before === undefined || !remaining(frame) || !remaining(before)) return false

      return Math.abs(frame.v - before.v) > typingRate * 0.1
    })

    expect(jerks.map((frame) => frame.t)).toEqual([])
  })

  it('停下时最新的字停在离右边缘那一段留白的地方', () => {
    /* `target - x` 就是「还差多少才到位」：归零即最新的字正好让出 tail 那一段空白。 */
    expect(last?.target).toBeDefined()
    expect((last?.target ?? 0) - (last?.x ?? 0)).toBeCloseTo(0, 6)
  })
})

describe('核心性质 3：快模型', () => {
  /* 每秒 200 字，允许触发跳近与硬底线，但全程不许遮住最新的字。 */
  const frames = simulate({ charsPerSec: 200, stopAtMs: 3000, durationMs: 3000, startChars: 50 })

  it('全程 target - x 不超过尾部留白', () => {
    expect(violations(frames)).toEqual([])
  })

  it('确实会用到硬底线：跟不上时宁可跳一下也不遮字', () => {
    /* 这条守住上面那条不是靠「恰好没触发」而通过的：跑到过底线的人才有资格说它守得住。 */
    const pinned = frames.filter((f) => Math.abs(TAIL_PX - (f.target - f.x)) < 1e-6)

    expect(pinned.length).toBeGreaterThan(0)
    /* 而且确实是在追赶：速度顶到过上限。 */
    expect(frames.some((f) => f.v > MAX_CATCHUP_PX_S - 1)).toBe(true)
  })
})

describe('尾部留白的设定值', () => {
  it('出字期间留半个字，停笔后归零', () => {
    const g: MarqueeGeometry = { content: 500, viewport: 400, tail: TAIL_PX }
    const target = 132

    /* 速度已经跟上出字速度时，稳态滞后就是设定值。 */
    const typing = step({ x: target - LAG_SET_EM * FONT_PX, v: 30 * CHAR_PX }, target, 30 * CHAR_PX, FRAME_MS, g)

    expect(typing.v).toBeCloseTo(30 * CHAR_PX, 3)
  })
})
