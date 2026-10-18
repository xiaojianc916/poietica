import { planWave, WAVE, type WaveSegment, waveFadeIn, waveSettledAt } from '@poietica/design-system/wave'
import { AT_REST, type GlideState, glideStep, MAX_DT_MS, noteShift, type Shift, shiftRate } from './ticker-glide'
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
 *
 * 新字的样子与回复正文是同一套（design-system/wave）：切成小段、错开起淡、淡完并回正文；颜色只有一种 ——
 * 轨道不写颜色，跟组头那一行（与工具调用同一档）走，「新」只由透明度说。
 *
 * 什么时候进轨道分两种，由「这一句放不放得下」决定：
 *   放得下：一批字按 planWave 的时刻成段进来，与回复逐段淡入一模一样（不动的行，段多大都不抖）；
 *   放不下：行在往左走，进轨道就是一次布局位移，段宽超过滑行的余量（tail − 设定值，约 1.5em）就是一跳 ——
 *          所以由 ticker-pace 匀速放字，同一个 stepMs 里放出的字合成一段起淡（与 planWave 的错开间隔同值）。
 */

/** 亚像素误差（< 0.5px）不当溢出，否则会引起滑行。 */
const OVERFLOW_EPS_PX = 0.5

export interface TickerOptions {
  readonly text: string
  /** 刚被换上来的新句：从第 0 个字开始出；否则（首次挂载、滚出视野再滚回来）整句直接摆好，不重播。 */
  readonly fresh: boolean
  readonly reduced: boolean
}

const commonPrefix = (a: string, b: string): number => {
  let index = 0

  while (index < a.length && index < b.length && a[index] === b[index]) index += 1

  return index
}

/** 进了轨道、还在淡的一段：淡完就并回 settled 文本节点，同时在场的 span 数与句长无关。 */
interface Fading {
  readonly segment: WaveSegment
  readonly node: HTMLSpanElement
}

export class TickerEngine {
  private readonly track: HTMLSpanElement
  private readonly settled: Text
  private readonly observer: ResizeObserver | null
  private readonly em: number
  private readonly tail: number
  private readonly animate: boolean
  private text: string
  private log: ArrivalLog
  private pace: PaceState
  private flushing = false
  /** 刚从「放得下」交给 pace、还没放出第一个字（见 advance）。 */
  private handoff = false
  /** 排着还没到时刻的段：按 from 升序、首尾相接，接在 fading（或 settled）后面。 */
  private queued: WaveSegment[] = []
  private fading: Fading[] = []
  /** 下一批最早何时起（planWave 的 cursor）：跨批共用，波首尾相接。 */
  private cursor = 0
  private glide: GlideState = AT_REST
  private shifts: Shift[] = []
  private trackWidth = 0
  private windowWidth = 0
  private overflow = 0
  private measured = false
  private frame: number | null = null
  private lastFrameAt = 0
  private stopped = false

  constructor(
    host: HTMLElement,
    private readonly options: TickerOptions,
  ) {
    this.track = document.createElement('span')
    this.track.className = 'ticker-track'
    this.settled = document.createTextNode('')
    this.track.append(this.settled)
    host.append(this.track)

    this.text = options.text
    this.animate = !options.reduced && typeof Element.prototype.animate === 'function'
    this.log = noteArrival(EMPTY_LOG, performance.now(), options.text.length)
    this.pace = { shown: 0, speed: 0 }

    /* 挂载时还没量过宽度，按放得下处理：新句从第一段淡起；首次挂载整句直接摆好。 */
    if (options.fresh && !options.reduced) this.plan(0, performance.now())
    else this.settleAll()

    /*
     * 字号与右侧留白只在挂载时读一次：逐帧读 getComputedStyle 会强制样式计算。
     * 滑行上限直接读轨道的 padding-inline-end（--cp-ticker-tail）：「最新的字不越过右边缘」靠的正是这段留白，
     * 上限与它只能有一个产地。读不到（无布局的测试环境）就是 0 —— 不滑，最坏只是不顺。
     */
    this.em = Number.parseFloat(getComputedStyle(host).fontSize) || 14
    this.tail = Number.parseFloat(getComputedStyle(this.track).paddingInlineEnd) || 0
    this.release(performance.now())

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

    const now = performance.now()
    const keep = commonPrefix(this.text, text)

    this.text = text
    this.log = noteArrival(this.log, now, text.length)

    if (this.options.reduced) {
      this.settleAll()
      return
    }

    /* 前面的字被改写了（`**` 闭合之类）：从改写处重新出，不留下错字。 */
    this.rewind(keep)

    if (!this.overflowing() && this.roomFor(text.length - this.planned())) this.plan(this.planned(), now)

    this.release(now)
    this.kick()
  }

  /** 下一句已经在等：排着的段立刻起，把这一句写完再刷走。 */
  setFlushing(flushing: boolean): void {
    this.flushing = flushing

    if (!flushing || this.stopped) return

    const now = performance.now()

    this.queued = this.queued.map((segment) => (segment.start > now ? { ...segment, start: now } : segment))
    this.cursor = Math.min(this.cursor, now)
    this.release(now)
    this.kick()
  }

  /** 退场：整句一次写完、停帧；旧句的位置保持此刻不动。 */
  finish(): void {
    if (this.stopped) return

    this.settleAll()
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
    this.advance(now, dt)
    this.release(now)

    const pxRate = this.overflow > OVERFLOW_EPS_PX ? shiftRate(this.shifts, now) : 0

    this.glide = this.options.reduced ? AT_REST : glideStep(this.glide, pxRate, this.em, this.tail, dt)
    this.paint()

    if (this.busy()) this.kick()
  }

  private busy(): boolean {
    return (
      this.planned() < this.text.length ||
      this.queued.length > 0 ||
      this.fading.length > 0 ||
      this.glide.o > 0 ||
      this.glide.v > 0
    )
  }

  private overflowing(): boolean {
    return this.overflow > OVERFLOW_EPS_PX
  }

  /**
   * 这一批新字还放不放得下：轨道右侧剩下的空够不够它们。
   * 段宽超过滑行余量（tail − 设定值 ≈ 1.5em）就是一跳，所以「放得下」不能只看上一帧有没有溢出 ——
   * 那一批刚好把行写满时，整批一次进轨道会挪出 6 个字的位移，而滑行只补得回 2.5em。
   * 量不到宽度（无布局的测试环境、首帧）按放得下处理。
   */
  private roomFor(chars: number): boolean {
    if (!this.measured || this.windowWidth <= 0) return true

    const shown = this.entered()

    if (shown <= 0) return chars * this.em <= this.windowWidth

    const charWidth = Math.max(1, (this.trackWidth - this.tail) / shown)

    return chars * charWidth <= Math.max(0, this.windowWidth - this.trackWidth)
  }

  /**
   * 还没进轨道的字怎么进来：放得下时按 planWave 成段排时刻（窗口拉宽、从放不下变回放得下时，剩下的也这样补上）；放不下时交给 pace 匀速放。
   * pace 每帧都走，只为让速度估计连续 —— 放得下时它的 shown 跟着已进轨道的字走，切到放不下时从这里接着放。
   */
  private advance(now: number, dt: number): void {
    const rate = incomingRate(this.log, now)
    const stepped = paceStep(this.pace, this.text.length, rate, this.log.gapMs, dt, this.flushing)
    /* 这一帧还排着的段（还没进轨道）用的是「放得下」的路径；已经开始滚的时候一律 pace。 */
    const fits = !this.overflowing() && this.roomFor(Math.max(0, this.text.length - this.entered()))

    if (fits) {
      /*
       * 放得下时字已按段进了轨道，pace 没有积压。速度钉在来字速度上，并记下「刚从放得下交过来」：paceStep 在
       * 没有积压时会把速度归零，写满后下一个字就要从 MIN_CPS 慢慢爬（实测停三帧），交接期间沿用这个速度。
       */
      this.pace = { shown: this.entered(), speed: Math.max(stepped.speed, rate) }
      this.handoff = true
      if (this.queued.length === 0 && this.planned() < this.text.length) this.plan(this.planned(), now)
      return
    }

    /*
     * 接手时速度不能掉到 0：交接那一刻 pace 没有积压，paceStep 会把速度归零，下一个字就要从 MIN_CPS 爬
     * （实测停 94ms）。沿用此刻的速度，且不低于来字速度 —— 这一批的字本来就该按来字速度匀速出。
     */
    const speed = this.handoff && stepped.speed === 0 ? this.pace.speed : stepped.speed

    this.pace = { shown: Math.max(stepped.shown, this.entered()), speed }

    /* 刚写满：按 planWave 排着的段（快模型下可积压到 spreadMs，几十个字）不再按时刻成段进来，退回给 pace 匀速放 —— 否则写满那一刻连跳几下。 */
    this.queued = []

    const count = visibleCount(this.text, this.pace.shown)

    if (count <= this.planned()) return

    this.handoff = false
    this.admit(this.planned(), count, now)
  }

  /** 放不下时 pace 放出来的字：上一段起淡还不到 stepMs 就并进去（同一段、同一个起点），否则另起一段。 */
  private admit(from: number, to: number, now: number): void {
    const last = this.fading[this.fading.length - 1]

    if (last !== undefined && last.segment.to === from && now - last.segment.start < WAVE.stepMs) {
      last.node.textContent = this.text.slice(last.segment.from, to)
      this.fading[this.fading.length - 1] = { segment: { ...last.segment, to }, node: last.node }
      return
    }

    this.queued.push({ from, to, start: now })
  }

  /** 已经进轨道的字到哪儿了（settled + 在淡的）。 */
  private entered(): number {
    return this.fading[this.fading.length - 1]?.segment.to ?? this.settled.data.length
  }

  /** 已经切好段的字到哪儿了（settled + 在淡的 + 排着的）。 */
  private planned(): number {
    return this.queued[this.queued.length - 1]?.to ?? this.entered()
  }

  /** 新到的字切段排时刻：与回复正文同一个 planWave，同一批字切得一样、起得一样。 */
  private plan(known: number, now: number): void {
    const wave = planWave(this.text, known, now, this.cursor, WAVE)

    this.queued.push(...wave.segments)
    this.cursor = wave.cursor
  }

  /** 屏幕上的字只保留与新文本相同的前缀；被改写掉的那截连同排着的段一起丢掉。 */
  private rewind(keep: number): void {
    if (this.pace.shown > keep) this.pace = { shown: keep, speed: this.pace.speed }

    this.queued = this.queued.filter((segment) => segment.to <= keep)

    const kept: Fading[] = []

    for (const entry of this.fading) {
      if (entry.segment.to <= keep) kept.push(entry)
      else entry.node.remove()
    }
    this.fading = kept

    if (this.settled.data.length > keep) {
      this.settled.data = this.settled.data.slice(0, keep)
      for (const entry of this.fading) entry.node.remove()
      this.fading = []
      this.queued = []
    }
  }

  /** 到时刻的段进轨道并挂淡入；淡完的并回 settled。 */
  private release(now: number): void {
    this.enter(now)
    this.merge(now)
  }

  private enter(now: number): void {
    let segment = this.queued[0]

    while (segment !== undefined && segment.start <= now) {
      this.queued.shift()

      const chunk = this.text.slice(segment.from, segment.to)

      if (this.animate) {
        const node = document.createElement('span')

        node.textContent = chunk
        this.track.append(node)
        waveFadeIn(node, segment.start, WAVE)
        this.fading.push({ segment, node })
      } else {
        this.settled.data += chunk
      }

      segment = this.queued[0]
    }
  }

  private merge(now: number): void {
    let entry = this.fading[0]

    while (entry !== undefined && now >= waveSettledAt(entry.segment, WAVE)) {
      this.fading.shift()
      this.settled.data += entry.node.textContent ?? ''
      entry.node.remove()
      entry = this.fading[0]
    }
  }

  private settleAll(): void {
    for (const entry of this.fading) entry.node.remove()
    this.fading = []
    this.queued = []
    this.settled.data = this.text
    this.pace = { shown: this.text.length, speed: 0 }
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
