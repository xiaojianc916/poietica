/*
 * 思考行的「放字」：成批到达的 token 先进一个小缓冲，再按估计的来字速度匀速放出来。
 *
 * 为什么要有这一层：token 从 core 经 host 到渲染进程，到这里是一批一批的 —— 几十到几百毫秒
 * 一批，一批一到十来个字。来一批显示一批，整行就一下一下地往左跳；在像素上硬追，追慢了把最新
 * 的字推出右边缘，追快了又一冲一冲。把「慢半拍」放在字符上：缓冲里压着不到一批的字，画面上
 * 看不见，像素那一层就只剩不到一个字的滑行（见 ticker-glide.ts），怎么都平。
 *
 * 纯函数，不碰 DOM，时间由调用方传入：测试直接喂到达序列、逐帧推（见 __tests__/ticker-pace.test.ts）。
 */

/** 估计来字速度用最近这么久的到达记录。短了会跟着每批的大小抖，长了停笔后要很久才认。 */
export const RATE_WINDOW_MS = 800

/** 速度估计的分母下限：刚起步时两批挨得很近，不设下限会把速度估得离谱。 */
export const RATE_MIN_SPAN_MS = 200

/** 到达间隔的滑动平均权重。 */
export const GAP_SMOOTHING = 0.25

/** 缓冲最多压这么久的字：再多，组头就明显落后于展开后的全文。 */
export const BUFFER_GAP_CAP_MS = 400

/** 积压偏离设定值时用多久纠正回来。 */
export const CORRECT_MS = 350

/** 放字速度本身的平滑时间常数：速度连续变化，不会一批来了猛冲一下。 */
export const SPEED_SMOOTH_MS = 140

/** 平时放字的上限（字/秒）。 */
export const MAX_CPS = 240

/** 收尾时（下一句已经在等）的上限：让旧句尽快写完再刷走。 */
export const FLUSH_CPS = 480

/** 积压超过这么多字（后台切回、一次来了一大段）：直接跳到只剩设定值，不慢慢追。 */
export const MAX_BACKLOG_CHARS = 60

/** 有积压时的最低放字速度：停顿之后来了新字，最迟约 66ms 就看得到第一个。 */
export const MIN_CPS = 15

/** 积压不足一个字时的最低速度：最后那个字不至于悬着半天才出来。 */
export const TAIL_CPS = 6

export interface Arrival {
  readonly at: number
  readonly length: number
}

export interface ArrivalLog {
  readonly samples: readonly Arrival[]
  /** 相邻两批之间的平均间隔（ms），0 表示还不知道。 */
  readonly gapMs: number
}

export const EMPTY_LOG: ArrivalLog = { samples: [], gapMs: 0 }

/**
 * 记一批到达。
 *
 * 文字变短（去 Markdown 记号时 `**` 闭合，前面的字被改写）不算一批新字：从这一刻重新记，
 * 否则后面几批会因为「没超过上次的长度」被当成没来。
 */
export function noteArrival(log: ArrivalLog, at: number, length: number): ArrivalLog {
  const last = log.samples[log.samples.length - 1]

  if (last === undefined) return { samples: [{ at, length }], gapMs: log.gapMs }
  if (length < last.length) return { samples: [{ at, length }], gapMs: log.gapMs }
  if (length === last.length) return log

  const gap = at - last.at
  const gapMs = log.gapMs === 0 ? gap : log.gapMs + (gap - log.gapMs) * GAP_SMOOTHING
  const samples = [...log.samples, { at, length }].filter((sample) => at - sample.at <= RATE_WINDOW_MS)

  return { samples, gapMs }
}

/** 来字速度（字/秒）：窗口内第一批到最后一批的增量 ÷ 时长。窗口内不足两批时为 0。 */
export function incomingRate(log: ArrivalLog, now: number): number {
  const recent = log.samples.filter((sample) => now - sample.at <= RATE_WINDOW_MS)
  const first = recent[0]
  const last = recent[recent.length - 1]

  if (first === undefined || last === undefined || recent.length < 2) return 0

  return ((last.length - first.length) / Math.max(now - first.at, RATE_MIN_SPAN_MS)) * 1000
}

export interface PaceState {
  /** 已经放出去多少个字（带小数：逐帧累加，取整后才是屏幕上的字数） */
  readonly shown: number
  /** 当前放字速度（字/秒） */
  readonly speed: number
}

function floorSpeed(speed: number, backlog: number): number {
  return Math.max(speed, backlog >= 1 ? MIN_CPS : TAIL_CPS)
}

/**
 * 推一帧。
 *
 * 设定值 = 来字速度 × 平均到达间隔，也就是「一批的量」：缓冲里常备一批，下一批来之前就不会
 * 放空，放字因此不停顿。收尾或停笔时设定值归零，缓冲自然放干。
 */
export function paceStep(
  state: PaceState,
  length: number,
  rate: number,
  gapMs: number,
  dtMs: number,
  flushing: boolean,
): PaceState {
  const backlog = length - state.shown

  if (backlog <= 0) return { shown: length, speed: 0 }

  const setPoint = flushing || rate === 0 ? 0 : (rate * Math.min(gapMs, BUFFER_GAP_CAP_MS)) / 1000

  if (backlog - setPoint > MAX_BACKLOG_CHARS) {
    return { shown: length - setPoint, speed: Math.max(state.speed, rate) }
  }

  const cap = flushing ? FLUSH_CPS : MAX_CPS
  const wanted = Math.min(Math.max(0, rate + (backlog - setPoint) / (CORRECT_MS / 1000)), cap)
  const smoothed = state.speed + (wanted - state.speed) * (1 - Math.exp(-dtMs / SPEED_SMOOTH_MS))
  const speed = floorSpeed(smoothed, backlog)

  return { shown: Math.min(length, state.shown + (speed * dtMs) / 1000), speed }
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** 屏幕上该显示几个 UTF-16 单元：取整，并且不把一个代理对（emoji 等）拆成两半。 */
export function visibleCount(text: string, shown: number): number {
  const count = Math.min(text.length, Math.max(0, Math.floor(shown)))

  if (count > 0 && count < text.length && isHighSurrogate(text.charCodeAt(count - 1))) return count + 1

  return count
}
