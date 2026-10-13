import {
  AT_REST,
  type GlideState,
  glideStep,
  MAX_DT_MS,
  noteShift,
  type Shift,
  shiftRate,
  TAIL_EM,
} from './ticker-glide'
import {
  type ArrivalLog,
  EMPTY_LOG,
  incomingRate,
  noteArrival,
  type PaceState,
  paceStep,
  visibleCount,
} from './ticker-pace'

/*
 * 「对」交给布局（rolling-line.css：最新的字越不过右边缘，句首不被吃掉），「顺」交给这里 —— 这里出错最坏是「不顺」，不会遮字。逐帧不进 React：轨道归引擎所有。
 */

/** 只变颜色不变透明度：透明度一变，右端读起来就是被遮了。 */
export const INK_MS = 450

/** 亚像素误差（< 0.5px）不当溢出，否则会引起滑行。 */
const OVERFLOW_EPS_PX = 0.5

export interface TickerOptions {
  readonly text: string
  /** 刚被换上来的新句：从第 0 个字开始写；否则（首次挂载、滚出视野再滚回来）整句直接摆好，不重播。 */
  readonly fresh: boolean
  readonly reduced: boolean
  /** 新字用「刚写下」的颜色（--cp-ticker-ink） */
  readonly ink: boolean
}

const commonPrefix = (a: string, b: string): number => {
  let index = 0

  while (index < a.length && index < b.length && a[index] === b[index]) index += 1

  return index
}

export class TickerEngine {
  private readonly track: HTMLSpanElement
  private readonly cooled: Text
  private readonly inked: HTMLSpanElement
  private readonly observer: ResizeObserver | null
  private readonly em: number
  private readonly tail: number
  private text: string
  private log: ArrivalLog
  private pace: PaceState
  private glide: GlideState = AT_REST
  private shifts: Shift[] = []
  /** 每个字被放出来的时刻；首屏就有的字记为 -∞。 */
  private releasedAt: number[] = []
  private rendered = -1
  private inkFrom = 0
  private trackWidth = 0
  private windowWidth = 0
  private overflow = 0
  private measured = false
  private flushing = false
  private frame: number | null = null
  private lastFrameAt = 0
  private stopped = false

  constructor(
    host: HTMLElement,
    private readonly options: TickerOptions,
  ) {
    this.track = document.createElement('span')
    this.track.className = 'ticker-track'
    this.cooled = document.createTextNode('')
    this.inked = document.createElement('span')
    this.inked.className = 'ticker-ink'
    this.track.append(this.cooled, this.inked)
    host.append(this.track)

    this.text = options.text
    this.log = noteArrival(EMPTY_LOG, performance.now(), options.text.length)
    this.pace = { shown: options.fresh && !options.reduced ? 0 : options.text.length, speed: 0 }
    /* 字号只在挂载时读一次：逐帧读 getComputedStyle 会强制样式计算。 */
    this.em = Number.parseFloat(getComputedStyle(host).fontSize) || 14
    this.tail = this.em * TAIL_EM
    this.render(performance.now())

    /* 一个观察者同时看轨道与窗口：同一次布局里的两处变化在同一个回调里到，算溢出时两个宽度同步。 */
    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            this.onResize(entries)
          })
    this.observer?.observe(this.track)
    this.observer?.observe(host)
    this.kick()
  }

  setText(text: string): void {
    if (this.stopped || text === this.text) return

    const keep = commonPrefix(this.text, text)

    /* 前面已经显示的字被改写了（`**` 闭合之类）：从改写处重新放，不留下错字。 */
    if (keep < visibleCount(this.text, this.pace.shown)) this.pace = { shown: keep, speed: this.pace.speed }

    this.text = text
    this.log = noteArrival(this.log, performance.now(), text.length)

    if (this.options.reduced) this.pace = { shown: text.length, speed: 0 }

    this.kick()
  }

  /** 下一句已经在等：加快把这一句写完。 */
  setFlushing(flushing: boolean): void {
    this.flushing = flushing
    this.kick()
  }

  /** 退场：整句一次写完、停帧；旧句的位置保持此刻不动。 */
  finish(): void {
    if (this.stopped) return

    this.pace = { shown: this.text.length, speed: 0 }
    this.render(performance.now())
    this.stop()
  }

  /** 卸载：停帧并摘掉自建的轨道（StrictMode 会挂回来，留两条轨道就错了）。 */
  dispose(): void {
    this.stop()
    this.track.remove()
  }

  private stop(): void {
    this.stopped = true

    if (this.frame !== null) cancelAnimationFrame(this.frame)

    this.frame = null
    this.observer?.disconnect()
  }

  private kick(): void {
    if (this.frame !== null || this.stopped) return

    this.lastFrameAt = performance.now()
    this.frame = requestAnimationFrame((now) => {
      this.loop(now)
    })
  }

  private loop(now: number): void {
    this.frame = null

    const dt = Math.min(MAX_DT_MS, Math.max(0, now - this.lastFrameAt))

    this.lastFrameAt = now
    this.pace = paceStep(this.pace, this.text.length, incomingRate(this.log, now), this.log.gapMs, dt, this.flushing)
    this.render(now)

    const pxRate = this.overflow > OVERFLOW_EPS_PX ? shiftRate(this.shifts, now) : 0

    this.glide = this.options.reduced ? AT_REST : glideStep(this.glide, pxRate, this.em, this.tail, dt)
    this.paint()

    if (this.busy()) this.kick()
  }

  private busy(): boolean {
    return this.pace.shown < this.text.length || this.glide.o > 0 || this.glide.v > 0 || this.inkFrom < this.rendered
  }

  private render(now: number): void {
    const count = visibleCount(this.text, this.pace.shown)

    for (let index = this.releasedAt.length; index < count; index += 1) {
      this.releasedAt.push(this.rendered < 0 ? Number.NEGATIVE_INFINITY : now)
    }
    this.releasedAt.length = count

    const from = this.options.ink && !this.options.reduced ? this.coolUntil(count, now) : count

    if (count === this.rendered && from === this.inkFrom) return

    this.rendered = count
    this.inkFrom = from
    this.cooled.data = this.text.slice(0, from)
    this.inked.textContent = this.text.slice(from, count)
  }

  /** 第一个还「刚写下」的字的位置：它之前的都已冷却。 */
  private coolUntil(count: number, now: number): number {
    let from = Math.min(this.inkFrom, count)

    while (from < count && now - (this.releasedAt[from] ?? Number.NEGATIVE_INFINITY) > INK_MS) from += 1

    return from
  }

  /**
   * RO 在布局之后、绘制之前送达，所以在这里补上的 o 与布局位移落在同一帧：看不到「先跳一下再补回来」。
   */
  private onResize(entries: readonly ResizeObserverEntry[]): void {
    const grew = this.readSizes(entries)
    const overflow = Math.max(0, this.trackWidth - this.windowWidth)

    if (grew > 0 && !this.options.reduced) {
      this.shifts = noteShift(this.shifts, performance.now(), grew)
      this.glide = { o: Math.min(this.tail, this.glide.o + Math.max(0, overflow - this.overflow)), v: this.glide.v }
    } else {
      /* 窗口变了：布局已把字摆对，不演滑行，只把 o 收进上限。 */
      this.glide = { o: Math.min(this.glide.o, this.tail), v: this.glide.v }
    }

    if (overflow <= OVERFLOW_EPS_PX) this.glide = AT_REST

    this.overflow = overflow
    this.measured = true
    this.paint()
    this.kick()
  }

  /** 更新两个宽度，返回轨道这次长了多少（首次量到是挂载，不算「长」）。 */
  private readSizes(entries: readonly ResizeObserverEntry[]): number {
    let grew = 0

    for (const entry of entries) {
      const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width

      if (entry.target === this.track) {
        if (this.measured && width > this.trackWidth) grew = width - this.trackWidth
        this.trackWidth = width
      } else {
        this.windowWidth = width
      }
    }

    return grew
  }

  private paint(): void {
    const moving = this.glide.o > 0.01

    this.track.style.transform = moving ? `translate3d(${String(this.glide.o)}px, 0, 0)` : ''
    this.track.toggleAttribute('data-moving', moving)
  }
}
