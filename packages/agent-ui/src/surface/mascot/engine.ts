/*
 * 吉祥物动效引擎：弹簧物理 + 相位连续振荡器，自动效实验稿逐参数移植。
 * step 写状态、render 落 SVG 属性，每帧单向走一遍。
 * 引擎不监听指针与偏好——输入只从 MascotHandle 进来，所有权在 React 壳。
 */

import { EXPRESSIONS, HEART_D, type MascotExpression, STAR_D } from './expressions'

const CX = 114.2705
const CY = 114.2705
const R = 105
const TAU = Math.PI * 2
const SVG_NS = 'http://www.w3.org/2000/svg'

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const easeIO = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const easeOut = (t: number) => 1 - (1 - t) ** 3

const pick = <T>(arr: readonly T[]): T => {
  const item = arr[Math.floor(Math.random() * arr.length)]
  if (item === undefined) {
    throw new Error('pick 不接受空列表')
  }
  return item
}

/* 弹簧：一切运动的地基——有惯性、有回弹，绝不匀速。 */
class Spring {
  x: number
  v = 0
  t: number
  f: number
  z: number

  constructor(value: number, frequency: number, damping: number) {
    this.x = value
    this.t = value
    this.f = frequency
    this.z = damping
  }

  step(dt: number): number {
    this.v += (-2 * this.z * this.f * this.v - this.f * this.f * (this.x - this.t)) * dt
    this.x += this.v * dt
    if (!Number.isFinite(this.x)) {
      this.x = this.t
      this.v = 0
    }
    return this.x
  }
}

type KeyframePoint = readonly [number, number]

/* 关键帧采样器（手势曲线）。 */
const kf = (pts: readonly KeyframePoint[], ease?: (t: number) => number) => {
  const e = ease ?? easeIO
  return (t: number): number => {
    const first = pts[0]
    const lastPoint = pts[pts.length - 1]
    if (first === undefined || lastPoint === undefined) {
      return 0
    }
    if (t <= first[0]) {
      return first[1]
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      if (a !== undefined && b !== undefined && t <= b[0]) {
        return lerp(a[1], b[1], e((t - a[0]) / (b[0] - a[0])))
      }
    }
    return lastPoint[1]
  }
}

type Gesture = {
  dur: number
  big?: boolean
  dy?: (u: number) => number
  rot?: (u: number) => number
  sq?: (u: number) => number
  sc?: (u: number) => number
  turn?: (u: number) => number
}

/* 手势库：叠加式一次性动作，进出平滑。 */
const G = {
  hop: (h = 16): Gesture => ({
    dur: 0.62,
    big: true,
    dy: kf([
      [0, 0],
      [0.1, 2.5],
      [0.36, -h],
      [0.6, 1],
      [0.8, -1.5],
      [1, 0],
    ]),
    sq: kf([
      [0, 0],
      [0.1, -0.11],
      [0.3, 0.16],
      [0.5, 0.02],
      [0.63, -0.14],
      [0.82, 0.06],
      [1, 0],
    ]),
  }),
  spin: (dir = 1): Gesture => ({
    dur: 0.9,
    big: true,
    turn: kf([
      [0, 0],
      [1, dir * TAU],
    ]),
    sq: kf([
      [0, 0],
      [0.4, 0.08],
      [1, 0],
    ]),
  }),
  recoil: (): Gesture => ({
    dur: 0.75,
    big: true,
    dy: kf([
      [0, 0],
      [0.12, -13],
      [0.42, -8],
      [0.75, 1.5],
      [1, 0],
    ]),
    rot: kf([
      [0, 0],
      [0.12, -5],
      [0.5, -2.5],
      [1, 0],
    ]),
    sq: kf([
      [0, 0],
      [0.1, 0.15],
      [0.4, 0.04],
      [0.6, -0.07],
      [1, 0],
    ]),
  }),
  nod2: (): Gesture => ({
    dur: 0.85,
    dy: kf([
      [0, 0],
      [0.18, 3.2],
      [0.36, 0],
      [0.56, 3.2],
      [0.76, 0],
      [1, 0],
    ]),
  }),
  tilt: (deg = 7): Gesture => ({
    dur: 1.15,
    rot: kf([
      [0, 0],
      [0.28, deg],
      [0.72, deg],
      [1, 0],
    ]),
  }),
  lean: (): Gesture => ({
    dur: 1.0,
    big: true,
    sc: kf([
      [0, 0],
      [0.3, 0.05],
      [0.72, 0.05],
      [1, 0],
    ]),
    dy: kf([
      [0, 0],
      [0.3, 1.6],
      [0.72, 1.6],
      [1, 0],
    ]),
  }),
  sink: (): Gesture => ({
    dur: 2.4,
    big: true,
    dy: kf([
      [0, 0],
      [0.55, 9],
      [0.66, 10],
      [0.74, -4],
      [0.88, 1],
      [1, 0],
    ]),
    rot: kf([
      [0, 0],
      [0.55, 4.5],
      [0.7, 4.5],
      [0.85, 0],
      [1, 0],
    ]),
  }),
  peekTurn: (a = -0.42): Gesture => ({
    dur: 1.8,
    turn: kf([
      [0, 0],
      [0.25, a],
      [0.7, a],
      [1, 0],
    ]),
  }),
  wake: (): Gesture => ({
    dur: 1.4,
    big: true,
    dy: kf([
      [0, 4],
      [0.3, 5],
      [0.55, -13],
      [0.75, 1],
      [1, 0],
    ]),
    sq: kf([
      [0, -0.1],
      [0.3, -0.12],
      [0.5, 0.15],
      [0.72, -0.05],
      [1, 0],
    ]),
  }),
}

export type SceneName =
  | 'idle'
  | 'listening'
  | 'speaking'
  | 'hello'
  | 'thinking'
  | 'loading'
  | 'working'
  | 'happy'
  | 'excited'
  | 'curious'
  | 'surprised'
  | 'confused'
  | 'shy'
  | 'sleepy'
  | 'sad'
  | 'celebrate'

type BlinkKind = 'quick' | 'soft' | 'sleepy'
type GazeMode = 'wander' | 'read' | 'upthink' | 'away' | 'down' | 'watch' | 'circle'
type Range = readonly [number, number]

type SceneSpec = {
  pool: readonly number[]
  expr: Range
  blink: Range
  bKind?: BlinkKind
  gaze: { mode: GazeMode; every: Range; ax?: number; ay?: number; ox?: number; oy?: number }
  mw: number
  tempo: number
  y?: number
  rotB?: number
  turnB?: number
  scale?: number
  es?: number
  blush?: number
  droop?: number
  dots?: number
  phys?: { mf?: number; mz?: number; hf?: number; hz?: number; gf?: number }
  breath: Range
  bob: Range
  sway: Range
  nod: Range
  tick?: (dt: number) => void
  enter?: () => void
  micro?: { every: Range; run: () => void }
}

const TOUR: readonly SceneName[] = [
  'idle',
  'hello',
  'curious',
  'listening',
  'thinking',
  'speaking',
  'loading',
  'working',
  'happy',
  'excited',
  'celebrate',
  'surprised',
  'confused',
  'shy',
  'sleepy',
  'sad',
]

const expressionAt = (index: number): MascotExpression => {
  const expression = EXPRESSIONS[index]
  if (expression === undefined) {
    throw new Error(`吉祥物表情索引越界：${index}`)
  }
  return expression
}

type MutablePoint = [number, number]
type MutableRings = MutablePoint[][]

const cloneExpression = (expression: MascotExpression): MutableRings =>
  expression.map((ring) => ring.map((p): MutablePoint => [p[0], p[1]]))

/* 环点是均匀采样，轮廓按闭合 Catmull-Rom 出三次贝塞尔：折线放大或形变会露棱角。 */
const ringPathD = (ring: readonly MutablePoint[]): string => {
  const n = ring.length
  const at = (i: number): MutablePoint => {
    const p = ring[(i + n) % n]
    if (p === undefined) {
      throw new Error('ringPathD 不接受空环')
    }
    return p
  }
  let d = `M${at(0)[0].toFixed(2)} ${at(0)[1].toFixed(2)}`
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += `C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`
  }
  return `${d}Z`
}

type ParticleShape = 'rect' | 'circle' | 'star' | 'heart'
type BurstKind = 'confetti' | 'sparkle' | 'heart'
type PoolNode = { el: SVGElement; shape: ParticleShape; free: boolean }
type Particle = {
  n: PoolNode
  age: number
  life: number
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vr: number
  g: number
  drag: number
  wob: number
  wobF: number
  tw: number
  size: number
}

const P_COLORS = ['#5E9FE8', '#EAC26B', '#72BC8F', '#BF8EDA', '#DE9255']
const SPARKLE_COLORS = ['#EAC26B', '#5E9FE8', '#e8b54d', '#BF8EDA']
const HEART_COLORS = ['#f095a8', '#ef8aa0', '#e8798f']
/* 轨道星子的三色与描边取自 CSS 令牌，跟随亮暗主题。 */
const ORBITER_COLORS = ['var(--mascot-star-1)', 'var(--mascot-star-2)', 'var(--mascot-star-3)']
const ORBITER_HALO = 'var(--mascot-halo)'
const TRAIL_SPECS = [
  { r: 2.7, o: 0.45 },
  { r: 1.85, o: 0.24 },
  { r: 1.15, o: 0.11 },
] as const

const setAttr = (el: Element, name: string, value: string | number) => {
  el.setAttribute(name, String(value))
}

export type MascotOptions = {
  tour: boolean
  follow: boolean
}

export type MascotHandle = {
  /* 外面交场景进来时,巡演必须是关着的:两个写者会互相覆盖。 */
  setScene: (name: SceneName) => void
  setTour: (on: boolean) => void
  setFollow: (on: boolean) => void
  pointerMoved: (clientX: number, clientY: number) => void
  dispose: () => void
}

export const mountMascot = (root: SVGSVGElement, options: MascotOptions): MascotHandle => {
  const find = <T extends Element>(selector: string): T => {
    const el = root.querySelector(selector)
    if (el === null) {
      throw new Error(`吉祥物骨架缺少 ${selector}`)
    }
    return el as T
  }
  const findPair = <T extends Element>(selector: string): [T, T] => {
    const els = root.querySelectorAll(selector)
    const first = els[0]
    const second = els[1]
    if (els.length !== 2 || first === undefined || second === undefined) {
      throw new Error(`吉祥物骨架 ${selector} 应恰有两个`)
    }
    return [first as T, second as T]
  }

  const rig = find<SVGGElement>("[data-part='rig']")
  const shadowEl = find<SVGEllipseElement>("[data-part='shadow']")
  const blushEl = find<SVGGElement>("[data-part='blush']")
  const blushEls = findPair<SVGEllipseElement>("[data-part='blush'] ellipse")
  const eyeEls = findPair<SVGPathElement>("[data-part='eye']")
  const fxBack = find<SVGGElement>("[data-part='fx-back']")
  const fxFront = find<SVGGElement>("[data-part='fx-front']")

  const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const AMP = RM ? 0.35 : 1

  let tNow = performance.now() / 1000
  let last = tNow

  const gestures: Array<Gesture & { t0: number }> = []
  const play = (g: Gesture) => {
    if (RM && g.big === true) {
      return
    }
    gestures.push({ ...g, t0: tNow })
  }

  const sp = {
    gx: new Spring(0, 7, 0.85),
    gy: new Spring(0, 7, 0.85),
    hx: new Spring(0, 4.2, 0.9),
    hy: new Spring(0, 4.2, 0.85),
    hr: new Spring(0, 4.8, 0.8),
    turn: new Spring(0, 5, 0.9),
    es: new Spring(1, 6, 0.9),
    sc: new Spring(1, 5, 0.9),
    morph: new Spring(1, 8.5, 0.92),
    press: new Spring(0, 14, 1),
    open: new Spring(1, 5, 0.9),
  }

  /* 相位连续的全局振荡器：频率/振幅平滑过渡，相位永不重置，循环首尾无跳变。 */
  const ph = { breath: rand(0, TAU), bob: rand(0, TAU), sway: rand(0, TAU), nod: 0, orbit: 0 }
  const live = {
    breathA: 1,
    breathHz: 0.32,
    bobA: 1,
    bobHz: 0.26,
    swayA: 1,
    swayHz: 0.19,
    nodA: 0,
    nodHz: 0.5,
    dots: 0,
    blush: 0,
    droop: 1,
    mw: 0.85,
  }

  let gazeT = { x: 0, y: 0 }
  let nextExpr = 0
  let nextBlink = 0
  let nextGaze = 0
  let nextMicro = 0
  let burstAt = Number.POSITIVE_INFINITY
  let burstKind: BurstKind = 'sparkle'
  let burstN = 8
  let hopAt = Number.POSITIVE_INFINITY
  let dblBlinkAt = Number.POSITIVE_INFINITY
  let esSoftAt = Number.POSITIVE_INFINITY
  let flourishAt = Number.POSITIVE_INFINITY
  let winkAt = Number.POSITIVE_INFINITY
  let thinkSide = 1
  let curSide = 1
  let readCol = -0.5

  const SCENES: Record<SceneName, SceneSpec> = {
    idle: {
      pool: [0, 8],
      expr: [4200, 8000],
      blink: [2400, 5200],
      gaze: { mode: 'wander', every: [1400, 3200], ax: 0.5, ay: 0.32, oy: -0.04 },
      mw: 0.85,
      tempo: 8.5,
      breath: [1, 0.32],
      bob: [1, 0.26],
      sway: [1, 0.19],
      nod: [0, 0.5],
      micro: {
        every: [5200, 10500],
        run() {
          pick([
            () => {
              gazeT = { x: rand(0.5, 0.8) * pick([-1, 1]), y: rand(-0.4, 0.1) }
              nextGaze = tNow + rand(0.7, 1.1)
            },
            () => play(G.hop(9)),
            () => play(G.tilt(pick([-7, 7]))),
            () => blink('quick', true),
            () => {
              play(G.lean())
              setExpression(pick([3, 15]))
            },
          ])()
        },
      },
    },
    listening: {
      pool: [10, 1, 19],
      expr: [2400, 4200],
      blink: [2600, 5200],
      gaze: { mode: 'watch', every: [900, 1800] },
      mw: 0.95,
      tempo: 9,
      y: -3,
      rotB: -2,
      es: 1.05,
      phys: { hf: 4.6, hz: 0.82 },
      breath: [0.9, 0.4],
      bob: [0.5, 0.3],
      sway: [0.35, 0.22],
      nod: [1, 0.6],
      enter() {
        play(G.hop(8))
      },
      micro: {
        every: [3600, 6800],
        run() {
          play(G.nod2())
        },
      },
    },
    speaking: {
      pool: [19, 1, 2, 10],
      expr: [1800, 3200],
      blink: [2600, 5000],
      gaze: { mode: 'watch', every: [1000, 2000] },
      mw: 0.9,
      tempo: 9,
      es: 1.02,
      phys: { mz: 0.72, hf: 4.8, hz: 0.75, gf: 8 },
      breath: [1, 0.42],
      bob: [0.7, 0.4],
      sway: [0.4, 0.24],
      nod: [0, 1.15],
      tick(dt) {
        const s = Math.sin((tNow * TAU) / 3.6) + 0.5 * Math.sin((tNow * TAU) / 1.27 + 1.7)
        const env = clamp(s * 1.6 + 0.55, 0, 1)
        live.nodA += (env * 1.9 * AMP - live.nodA) * Math.min(1, 6 * dt)
      },
      enter() {
        play(G.hop(7))
      },
      micro: {
        every: [3000, 5600],
        run() {
          pick([
            () => play(G.nod2()),
            () => {
              setExpression(2)
              play(G.hop(6))
            },
            () => play(G.tilt(pick([-5, 5]))),
          ])()
        },
      },
    },
    hello: {
      pool: [2, 19, 0],
      expr: [2200, 3800],
      blink: [2400, 4600],
      gaze: { mode: 'watch', every: [900, 1800] },
      mw: 0.95,
      tempo: 10,
      es: 1.05,
      blush: 0.3,
      phys: { mz: 0.66, hf: 5, hz: 0.7 },
      breath: [1.1, 0.4],
      bob: [1.1, 0.42],
      sway: [0.8, 0.26],
      nod: [0, 0.5],
      enter() {
        play(G.hop(17))
        winkAt = tNow + 0.55
      },
      micro: {
        every: [5200, 9000],
        run() {
          if (Math.random() < 0.55) {
            wink()
          } else {
            play(G.hop(10))
          }
        },
      },
    },
    thinking: {
      pool: [8, 16, 14, 17, 5],
      expr: [1700, 3000],
      blink: [3000, 6000],
      gaze: { mode: 'upthink', every: [1500, 2600] },
      mw: 0.25,
      tempo: 8,
      phys: { gf: 6 },
      breath: [0.85, 0.34],
      bob: [0.7, 0.22],
      sway: [0.5, 0.15],
      nod: [0, 0.5],
      micro: {
        every: [3400, 6200],
        run() {
          if (Math.random() < 0.5) {
            blink('soft')
          } else {
            play(G.tilt(thinkSide * 6))
          }
        },
      },
    },
    loading: {
      pool: [0, 8],
      expr: [3200, 5200],
      blink: [4200, 7200],
      gaze: { mode: 'circle', every: [400, 400] },
      mw: 0.15,
      tempo: 8,
      dots: 1,
      es: 0.97,
      phys: { gf: 5.5 },
      breath: [1.5, 0.72],
      bob: [0.4, 0.5],
      sway: [0.3, 0.4],
      nod: [0, 0.5],
    },
    working: {
      pool: [7, 16, 11, 10],
      expr: [1500, 2800],
      blink: [2200, 4500],
      gaze: { mode: 'read', every: [420, 950], oy: 0.34 },
      mw: 0.3,
      tempo: 10,
      y: 1,
      phys: { mz: 0.75, gf: 9.5 },
      breath: [1, 0.45],
      bob: [0.8, 0.55],
      sway: [0.2, 0.3],
      nod: [0.7, 0.85],
      micro: {
        every: [5200, 9000],
        run() {
          gazeT = { x: 0, y: -0.05 }
          nextGaze = tNow + rand(0.8, 1.2)
        },
      },
    },
    happy: {
      pool: [2, 11, 17, 19],
      expr: [2000, 3600],
      blink: [2400, 4800],
      gaze: { mode: 'watch', every: [900, 1700] },
      mw: 0.8,
      tempo: 10,
      es: 1.04,
      blush: 0.6,
      phys: { mz: 0.62, hf: 4.9, hz: 0.7 },
      breath: [1.2, 0.45],
      bob: [1.4, 0.5],
      sway: [0.8, 0.3],
      nod: [0, 0.5],
      enter() {
        play(G.hop(16))
      },
      micro: {
        every: [3600, 6600],
        run() {
          play(G.hop(rand(8, 13)))
          if (Math.random() < 0.22) {
            burst(1, 'heart')
          }
        },
      },
    },
    excited: {
      pool: [2, 17, 21, 3, 11],
      expr: [900, 1700],
      blink: [1800, 3600],
      gaze: { mode: 'wander', every: [600, 1300], ax: 0.55, ay: 0.4 },
      mw: 0.7,
      tempo: 12,
      es: 1.1,
      phys: { mz: 0.55, hf: 5.4, hz: 0.62, gf: 8.5 },
      breath: [1.3, 0.6],
      bob: [2.2, 0.9],
      sway: [1, 0.5],
      nod: [0, 0.5],
      enter() {
        play(G.hop(24))
        burstAt = tNow + 0.12
        burstKind = 'sparkle'
        burstN = 9
      },
      micro: {
        every: [2400, 4600],
        run() {
          pick([
            () => play(G.hop(14)),
            () => play(G.spin(pick([-1, 1]))),
            () => burst(8, 'sparkle'),
          ])()
        },
      },
    },
    curious: {
      pool: [3, 21, 0, 15],
      expr: [1500, 2800],
      blink: [2200, 4400],
      gaze: { mode: 'wander', every: [700, 1600], ax: 0.8, ay: 0.5 },
      mw: 0.95,
      tempo: 10,
      rotB: 6,
      scale: 1.045,
      es: 1.08,
      phys: { mz: 0.68, hf: 5.2, gf: 8.5 },
      breath: [1, 0.4],
      bob: [0.8, 0.3],
      sway: [0.4, 0.24],
      nod: [0, 0.5],
      enter() {
        play(G.lean())
      },
      micro: {
        every: [2800, 5400],
        run() {
          curSide *= -1
          play(G.tilt(curSide * 9))
        },
      },
    },
    surprised: {
      pool: [3, 21],
      expr: [2200, 3800],
      blink: [1500, 2800],
      gaze: { mode: 'watch', every: [800, 1500] },
      mw: 0.9,
      tempo: 11,
      es: 1.16,
      y: -2,
      phys: { mf: 13, mz: 0.5, hf: 6.6, hz: 0.55, gf: 10 },
      breath: [1.4, 0.7],
      bob: [0.3, 0.4],
      sway: [0.2, 0.3],
      nod: [0, 0.5],
      enter() {
        play(G.recoil())
        sp.es.x = 1.45
        blinkHoldUntil = tNow + 1.05
        dblBlinkAt = tNow + 1.1
        esSoftAt = tNow + 2.6
      },
    },
    confused: {
      pool: [14, 5, 8],
      expr: [1900, 3400],
      blink: [2600, 5000],
      gaze: { mode: 'wander', every: [1100, 2200], ax: 0.55, ay: 0.4, oy: -0.25 },
      mw: 0.5,
      tempo: 7,
      es: 0.98,
      phys: { mf: 6.5, mz: 0.98, hf: 3.4, gf: 5.5 },
      breath: [0.9, 0.3],
      bob: [0.5, 0.2],
      sway: [2.6, 0.13],
      nod: [0, 0.5],
      micro: {
        every: [2800, 5200],
        run() {
          if (Math.random() < 0.4) {
            blink('quick', true)
          } else {
            play(G.tilt(pick([-9, 9])))
          }
        },
      },
    },
    shy: {
      pool: [0, 24, 13],
      expr: [2400, 4200],
      blink: [2000, 4000],
      gaze: { mode: 'away', every: [1600, 3000] },
      mw: 0.3,
      tempo: 8,
      turnB: 0.5,
      rotB: -3,
      scale: 0.96,
      blush: 1,
      y: 2,
      phys: { mf: 7, mz: 0.82, hf: 3.6, gf: 6 },
      breath: [0.9, 0.36],
      bob: [0.6, 0.24],
      sway: [0.5, 0.18],
      nod: [0, 0.5],
      micro: {
        every: [2600, 4800],
        run() {
          play(G.peekTurn(-0.42))
          gazeT = { x: -0.1, y: -0.05 }
          nextGaze = tNow + 1.1
          if (Math.random() < 0.4) {
            burst(2, 'heart')
          }
        },
      },
    },
    sleepy: {
      pool: [4, 22, 13],
      expr: [3800, 6800],
      blink: [1800, 3800],
      bKind: 'sleepy',
      gaze: { mode: 'down', every: [2200, 4200] },
      mw: 0.15,
      tempo: 5,
      y: 7,
      rotB: 2.5,
      droop: 0.66,
      es: 0.97,
      phys: { mf: 4.2, mz: 1.15, hf: 2.5, hz: 1.05, gf: 3.6 },
      breath: [1.6, 0.18],
      bob: [0.8, 0.13],
      sway: [0.8, 0.1],
      nod: [0, 0.5],
      micro: {
        every: [4200, 8200],
        run() {
          play(G.sink())
          dblBlinkAt = tNow + 1.9
        },
      },
    },
    sad: {
      pool: [4, 13, 22],
      expr: [3600, 6400],
      blink: [3400, 6400],
      bKind: 'soft',
      gaze: { mode: 'down', every: [2600, 4600] },
      mw: 0.25,
      tempo: 6,
      y: 6,
      rotB: -2,
      droop: 0.8,
      es: 0.95,
      phys: { mf: 5, mz: 1.05, hf: 2.9, hz: 1, gf: 4.5 },
      breath: [1.2, 0.22],
      bob: [0.5, 0.16],
      sway: [0.3, 0.13],
      nod: [0, 0.5],
      micro: {
        every: [5200, 9200],
        run() {
          gazeT = { x: 0, y: -0.2 }
          nextGaze = tNow + rand(1, 1.4)
        },
      },
    },
    celebrate: {
      pool: [2, 8, 17],
      expr: [1100, 2000],
      blink: [2000, 4000],
      gaze: { mode: 'wander', every: [700, 1400], ax: 0.5, ay: 0.35 },
      mw: 0.6,
      tempo: 11,
      es: 1.08,
      blush: 0.5,
      phys: { mz: 0.58, hf: 5.1, hz: 0.64 },
      breath: [1.2, 0.55],
      bob: [2, 0.95],
      sway: [1.2, 0.5],
      nod: [0, 0.5],
      enter() {
        play(G.spin(1))
        burstAt = tNow + 0.3
        burstKind = 'confetti'
        burstN = 22
        hopAt = tNow + 0.75
      },
      micro: {
        every: [1900, 3400],
        run() {
          pick([() => burst(10, 'confetti'), () => play(G.hop(13))])()
        },
      },
    },
  }

  /* ===== 表情形变：48 点环插值，弹簧驱动，允许轻微过冲。 ===== */
  let exprIndex = 0
  let baseRings = cloneExpression(expressionAt(0))
  let tgtRings = expressionAt(0)
  let pathDirty = true

  const currentRings = (): MutableRings => {
    const m0 = clamp(sp.morph.x, -0.12, 1.15)
    const m1 = clamp((sp.morph.x - 0.07) / 0.93, -0.12, 1.15)
    return baseRings.map((ring, ringIndex) => {
      const k = ringIndex === 0 ? m0 : m1
      const target = tgtRings[ringIndex]
      return ring.map((point, pointIndex): MutablePoint => {
        const q = target?.[pointIndex] ?? point
        return [point[0] + (q[0] - point[0]) * k, point[1] + (q[1] - point[1]) * k]
      })
    })
  }

  function setExpression(i: number) {
    baseRings = currentRings()
    tgtRings = expressionAt(i)
    exprIndex = i
    sp.morph.x = 0
    sp.morph.v *= 0.25
    sp.morph.t = 1
    pathDirty = true
  }

  /* ===== 眨眼：快合慢开 + 双眨 + 困倦慢眨。 ===== */
  let blinkAnim: { t0: number; kind: BlinkKind; again: boolean } | null = null
  let blinkHoldUntil = 0

  function blink(kind: BlinkKind, again = false) {
    if (tNow < blinkHoldUntil) {
      return
    }
    blinkAnim = { t0: tNow, kind, again }
  }

  const openness = (): number => {
    let o = 1
    if (blinkAnim !== null) {
      const k = blinkAnim.kind
      const dur = k === 'sleepy' ? 0.78 : k === 'soft' ? 0.26 : 0.16
      const u = (tNow - blinkAnim.t0) / dur
      if (u >= 1) {
        blinkAnim = blinkAnim.again ? { t0: tNow + 0.09, kind: k, again: false } : null
      } else if (u >= 0) {
        if (k === 'sleepy') {
          o =
            u < 0.3
              ? 1 - easeIO(u / 0.3) * 0.95
              : u < 0.62
                ? 0.05
                : 0.05 + easeOut((u - 0.62) / 0.38) * 0.95
        } else {
          o = u < 0.4 ? 1 - easeIO(u / 0.4) * 0.95 : 0.05 + easeOut((u - 0.4) / 0.6) * 0.99
        }
      }
    }
    return clamp(o, 0.03, 1.04) * clamp(sp.open.x, 0, 1.04)
  }

  /* ===== 眨单眼。 ===== */
  let winkT0 = -9
  let winkEye = 1

  function wink(eye?: number) {
    winkEye = eye ?? (Math.random() < 0.5 ? 0 : 1)
    winkT0 = tNow
    play(G.tilt(winkEye === 1 ? 7 : -7))
  }

  const winkEnv = (i: number): number => {
    if (i !== winkEye) {
      return 1
    }
    const u = (tNow - winkT0) / 0.62
    if (u < 0 || u >= 1) {
      return 1
    }
    return u < 0.18
      ? 1 - easeIO(u / 0.18) * 0.94
      : u < 0.55
        ? 0.06
        : 0.06 + easeOut((u - 0.55) / 0.45) * 0.94
  }

  /* ===== 视线目标：自主漫游，与指针按场景性格混合。 ===== */
  const pointer = { x: 0, y: 0, at: -9 }
  let follow = options.follow
  let scene: SceneSpec = SCENES.idle
  let sceneName: SceneName | null = null

  function retargetGaze() {
    const g = scene.gaze
    const ax = g.ax ?? 0.5
    const ay = g.ay ?? 0.35
    const ox = g.ox ?? 0
    const oy = g.oy ?? 0
    if (g.mode === 'wander') {
      gazeT =
        Math.random() < 0.14
          ? { x: 0, y: -0.05 }
          : { x: rand(-1, 1) * ax + ox, y: rand(-1, 1) * ay + oy }
    } else if (g.mode === 'read') {
      readCol += rand(0.28, 0.42)
      if (readCol > 0.6) {
        readCol = -0.55
      }
      gazeT = { x: readCol, y: oy + rand(-0.05, 0.1) }
    } else if (g.mode === 'upthink') {
      thinkSide *= -1
      gazeT = { x: thinkSide * rand(0.35, 0.6), y: -rand(0.45, 0.75) }
    } else if (g.mode === 'away') {
      gazeT = { x: 0.45 + rand(0, 0.18), y: 0.28 + rand(0, 0.15) }
    } else if (g.mode === 'down') {
      gazeT = { x: rand(-0.15, 0.15), y: 0.5 + rand(0, 0.12) }
    } else if (g.mode === 'watch') {
      gazeT = { x: rand(-0.12, 0.12), y: rand(-0.1, 0.08) }
    }
    nextGaze = tNow + rand(g.every[0], g.every[1]) / 1000
  }

  /* ===== 粒子：彩带 / 星星 / 爱心。 ===== */
  const pool: PoolNode[] = []
  const parts: Particle[] = []

  const getNode = (shape: ParticleShape): PoolNode | null => {
    for (const n of pool) {
      if (n.free && n.shape === shape) {
        n.free = false
        return n
      }
    }
    if (pool.length > 40) {
      return null
    }
    const isPath = shape === 'star' || shape === 'heart'
    const el = document.createElementNS(SVG_NS, isPath ? 'path' : shape)
    if (shape === 'rect') {
      setAttr(el, 'x', -2.9)
      setAttr(el, 'y', -1.9)
      setAttr(el, 'width', 5.8)
      setAttr(el, 'height', 3.8)
      setAttr(el, 'rx', 1.1)
    } else if (shape === 'circle') {
      setAttr(el, 'r', 2.3)
    } else {
      setAttr(el, 'd', shape === 'star' ? STAR_D : HEART_D)
    }
    el.style.opacity = '0'
    fxFront.appendChild(el)
    const node = { el, shape, free: false }
    pool.push(node)
    return node
  }

  const spawn = (o: {
    shape: ParticleShape
    color: string
    x: number
    y: number
    vx: number
    vy: number
    life: number
    size?: number
    g?: number
    drag?: number
    vr?: number
    wob?: number
    wobF?: number
    tw?: number
  }) => {
    const node = getNode(o.shape)
    if (node === null) {
      return
    }
    node.el.setAttribute('fill', o.color)
    parts.push({
      n: node,
      age: 0,
      rot: rand(0, 360),
      x: o.x,
      y: o.y,
      vx: o.vx,
      vy: o.vy,
      life: o.life,
      vr: o.vr ?? 0,
      g: o.g ?? 0,
      drag: o.drag ?? 0,
      wob: o.wob ?? 0,
      wobF: o.wobF ?? 5,
      tw: o.tw ?? 0,
      size: o.size ?? 1,
    })
  }

  function burst(count: number, kind: BurstKind) {
    if (RM) {
      return
    }
    const hx = CX + sp.hx.x
    const top = CY + sp.hy.x - 82
    for (let i = 0; i < count; i++) {
      if (kind === 'confetti') {
        spawn({
          shape: i % 4 === 3 ? 'circle' : 'rect',
          color: pick(P_COLORS),
          x: hx + rand(-46, 46),
          y: top + rand(-14, 8),
          vx: rand(-1, 1) * 175,
          vy: rand(-250, -120),
          g: 470,
          drag: 1.7,
          vr: rand(-460, 460),
          wob: rand(4, 13),
          wobF: rand(4, 8),
          life: rand(1.05, 1.6),
          size: rand(0.8, 1.35),
        })
      } else if (kind === 'sparkle') {
        const a = rand(0, TAU)
        spawn({
          shape: 'star',
          color: pick(SPARKLE_COLORS),
          x: hx + Math.cos(a) * rand(52, 88),
          y: CY + sp.hy.x - 44 + Math.sin(a) * rand(26, 56),
          vx: rand(-38, 38),
          vy: rand(-54, -20),
          g: -14,
          drag: 0.6,
          vr: rand(-140, 140),
          tw: rand(8, 12),
          life: rand(0.55, 0.95),
          size: rand(0.7, 1.25),
        })
      } else {
        spawn({
          shape: 'heart',
          color: pick(HEART_COLORS),
          x: hx + rand(-1, 1) * 52,
          y: CY + sp.hy.x + rand(14, 38),
          vx: rand(-22, 22),
          vy: rand(-52, -30),
          g: -10,
          drag: 0.5,
          vr: rand(-36, 36),
          wob: rand(3, 6),
          wobF: rand(2.5, 4),
          life: rand(0.95, 1.3),
          size: rand(0.85, 1.2),
        })
      }
    }
  }

  const stepParts = (dt: number) => {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      if (p === undefined) {
        continue
      }
      p.age += dt
      if (p.age >= p.life) {
        p.n.el.style.opacity = '0'
        p.n.free = true
        parts.splice(i, 1)
        continue
      }
      const damp = Math.max(0, 1 - p.drag * dt)
      p.vx *= damp
      p.vy += p.g * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.rot += p.vr * dt
      const px = p.x + (p.wob !== 0 ? Math.sin(p.age * p.wobF) * p.wob * Math.min(1, p.age * 2) : 0)
      const grow = easeOut(Math.min(1, p.age / 0.14))
      const fade = p.age > p.life - 0.32 ? (p.life - p.age) / 0.32 : 1
      const tw = p.tw !== 0 ? 0.78 + 0.3 * Math.sin(p.age * p.tw) : 1
      setAttr(
        p.n.el,
        'transform',
        `translate(${px.toFixed(2)} ${p.y.toFixed(2)}) rotate(${(p.rot % 360).toFixed(1)}) scale(${(grow * p.size * tw).toFixed(3)})`,
      )
      p.n.el.style.opacity = (0.95 * fade).toFixed(3)
    }
  }

  /* ===== 加载轨道星子：倾斜轨道 + 星形头 + 彗尾拖影。 ===== */
  const orbiters = ORBITER_COLORS.map((color) => {
    const g = document.createElementNS(SVG_NS, 'g')
    const trail = TRAIL_SPECS.map((spec) => {
      const el = document.createElementNS(SVG_NS, 'circle')
      el.setAttribute('fill', color)
      el.setAttribute('stroke', ORBITER_HALO)
      el.setAttribute('stroke-width', '0.9')
      el.setAttribute('paint-order', 'stroke')
      g.appendChild(el)
      return { el, r: spec.r, o: spec.o }
    })
    const head = document.createElementNS(SVG_NS, 'path')
    head.setAttribute('d', STAR_D)
    head.setAttribute('fill', color)
    head.setAttribute('stroke', ORBITER_HALO)
    head.setAttribute('stroke-width', '1.3')
    head.setAttribute('stroke-linejoin', 'round')
    head.setAttribute('paint-order', 'stroke')
    g.appendChild(head)
    g.style.opacity = '0'
    fxBack.appendChild(g)
    return { g, head, trail }
  })

  /* ===== 场景切换：眨眼掩护 + 基线平滑过渡，无重置跳变。 ===== */
  let tourOn = false
  let tourAt = Number.POSITIVE_INFINITY
  let tourIdx = 0

  function setScene(name: SceneName, opts?: { silent?: boolean }) {
    if (name === sceneName) {
      return
    }
    const prev = sceneName
    scene = SCENES[name]
    sceneName = name
    const silent = opts?.silent === true
    sp.turn.t = scene.turnB ?? 0
    sp.es.t = scene.es ?? 1
    sp.sc.t = scene.scale ?? 1
    const phys = scene.phys ?? {}
    sp.morph.f = phys.mf ?? scene.tempo
    sp.morph.z = phys.mz ?? 0.92
    sp.hx.f = phys.hf ?? 4.2
    sp.hy.f = phys.hf ?? 4.2
    sp.hx.z = phys.hz ?? 0.88
    sp.hy.z = phys.hz ?? 0.88
    sp.hr.f = (phys.hf ?? 4.2) * 1.15
    sp.hr.z = phys.hz ?? 0.8
    sp.gx.f = phys.gf ?? 7
    sp.gy.f = phys.gf ?? 7
    nextExpr = tNow + (rand(scene.expr[0], scene.expr[1]) * 0.45) / 1000
    nextBlink = tNow + (rand(scene.blink[0], scene.blink[1]) * 0.5) / 1000
    nextGaze = tNow + 0.05
    nextMicro =
      scene.micro !== undefined
        ? tNow + (rand(scene.micro.every[0], scene.micro.every[1]) * 0.6) / 1000
        : Number.POSITIVE_INFINITY
    esSoftAt = Number.POSITIVE_INFINITY
    setExpression(pick(scene.pool))
    if (prev !== null && !silent) {
      blink(scene.bKind === 'sleepy' ? 'soft' : 'quick')
    }
    if (prev === 'loading') {
      flourishAt = tNow + 0.18
    }
    if (scene.enter !== undefined && !RM && !silent) {
      scene.enter()
    }
  }

  /* ===== 主循环：step 写逻辑，render 落绘制。 ===== */
  function step(dt: number) {
    const bl = (key: keyof typeof live, target: number) => {
      live[key] += (target - live[key]) * Math.min(1, 3.2 * dt)
    }
    bl('breathA', scene.breath[0] * AMP)
    bl('breathHz', scene.breath[1])
    bl('bobA', scene.bob[0] * AMP)
    bl('bobHz', scene.bob[1])
    bl('swayA', scene.sway[0] * AMP)
    bl('swayHz', scene.sway[1])
    bl('nodA', scene.nod[0] * AMP)
    bl('nodHz', scene.nod[1])
    bl('dots', scene.dots ?? 0)
    bl('blush', scene.blush ?? 0)
    bl('droop', scene.droop ?? 1)
    bl('mw', scene.mw)
    scene.tick?.(dt)
    ph.breath += TAU * live.breathHz * dt
    ph.bob += TAU * live.bobHz * dt
    ph.sway += TAU * live.swayHz * dt
    ph.nod += TAU * live.nodHz * dt
    ph.orbit +=
      TAU * (sceneName === 'loading' ? 0.55 : 0.3) * (1 + 0.16 * Math.sin((tNow * TAU) / 4.6)) * dt

    if (tNow > nextExpr) {
      const cand = scene.pool.filter((i) => i !== exprIndex)
      setExpression(cand.length > 0 ? pick(cand) : (scene.pool[0] ?? 0))
      nextExpr = tNow + rand(scene.expr[0], scene.expr[1]) / 1000
    }
    if (tNow > nextBlink && blinkAnim === null) {
      blink(scene.bKind ?? 'quick', Math.random() < 0.28)
      nextBlink = tNow + rand(scene.blink[0], scene.blink[1]) / 1000
    }
    if (tNow > nextGaze) {
      retargetGaze()
    }
    if (tNow > nextMicro && scene.micro !== undefined) {
      scene.micro.run()
      nextMicro = tNow + rand(scene.micro.every[0], scene.micro.every[1]) / 1000
    }
    if (tNow > burstAt) {
      burstAt = Number.POSITIVE_INFINITY
      burst(burstN, burstKind)
    }
    if (tNow > hopAt) {
      hopAt = Number.POSITIVE_INFINITY
      play(G.hop(20))
    }
    if (tNow > winkAt) {
      winkAt = Number.POSITIVE_INFINITY
      wink()
    }
    if (tNow > dblBlinkAt) {
      dblBlinkAt = Number.POSITIVE_INFINITY
      blinkHoldUntil = 0
      blink('quick', true)
      sp.es.t = scene.es ?? 1
    }
    if (tNow > esSoftAt) {
      esSoftAt = Number.POSITIVE_INFINITY
      sp.es.t = 1.06
    }
    if (tNow > flourishAt) {
      flourishAt = Number.POSITIVE_INFINITY
      play(G.hop(11))
      sp.es.x = (scene.es ?? 1) * 1.14
      burst(6, 'sparkle')
    }
    if (tNow > tourAt) {
      tourIdx = (tourIdx + 1) % TOUR.length
      const next = TOUR[tourIdx]
      if (next !== undefined) {
        setScene(next)
      }
      tourAt = tNow + 5.2
    }
    const introStep = intro[0]
    if (introStep !== undefined && tNow > introStep[0]) {
      intro.shift()
      introStep[1]()
    }

    /* 微颤视线：扫视时的小跳动。 */
    const mode = scene.gaze.mode
    if ((mode === 'wander' || mode === 'read') && Math.random() < dt * 0.35) {
      gazeT = {
        x: clamp(gazeT.x + rand(-0.06, 0.06), -1, 1),
        y: clamp(gazeT.y + rand(-0.04, 0.04), -1, 1),
      }
    }

    let auto = gazeT
    if (mode === 'circle') {
      auto = { x: Math.cos(ph.orbit) * 0.55, y: Math.sin(ph.orbit) * 0.4 - 0.08 }
    }
    const recent = clamp(1 - (tNow - pointer.at) / 2.5, 0, 1)
    const w = follow ? live.mw * recent : 0
    sp.gx.t = lerp(auto.x, pointer.x, w)
    sp.gy.t = lerp(auto.y, pointer.y, w)

    /* 眼睛先动，头部慢半拍跟随。 */
    sp.hx.t = sp.gx.x * 6.2
    sp.hy.t = (scene.y ?? 0) + sp.gy.x * 3.6
    sp.hr.t = (scene.rotB ?? 0) + sp.gx.x * 3.4
    sp.turn.t = (scene.turnB ?? 0) + sp.gx.x * 0.12

    for (const spring of Object.values(sp)) {
      spring.step(dt)
    }
    stepParts(dt)
  }

  const sampleGestureOffsets = () => {
    let gdy = 0
    let grot = 0
    let gsq = 0
    let gsc = 0
    let gturn = 0
    for (let i = gestures.length - 1; i >= 0; i--) {
      const g = gestures[i]
      if (g === undefined) {
        continue
      }
      const u = (tNow - g.t0) / g.dur
      if (u >= 1) {
        gestures.splice(i, 1)
        continue
      }
      if (u < 0) {
        continue
      }
      if (g.dy !== undefined) {
        gdy += g.dy(u)
      }
      if (g.rot !== undefined) {
        grot += g.rot(u)
      }
      if (g.sq !== undefined) {
        gsq += g.sq(u)
      }
      if (g.sc !== undefined) {
        gsc += g.sc(u)
      }
      if (g.turn !== undefined) {
        gturn += g.turn(u)
      }
    }
    return { gdy, grot, gsq, gsc, gturn }
  }

  function render() {
    const { gdy, grot, gsq, gsc, gturn } = sampleGestureOffsets()

    /* 呼吸/漂浮/摇曳/点头。 */
    const br = Math.sin(ph.breath) * live.breathA
    const dy =
      Math.sin(ph.bob) * 2.6 * live.bobA + br * 1.1 + Math.sin(ph.nod) * 1.7 * live.nodA + gdy
    const rot = Math.sin(ph.sway) * 1.35 * live.swayA + sp.hr.x + grot
    const sq = gsq + sp.press.x
    const S = sp.sc.x + gsc
    const sxF = S * (1 - sq * 0.85) * (1 - br * 0.005)
    const syF = S * (1 + sq) * (1 + br * 0.011)
    const x = CX + sp.hx.x
    const y = CY + sp.hy.x + dy
    setAttr(
      rig,
      'transform',
      `translate(${x} ${y}) rotate(${rot}) scale(${sxF} ${syF}) translate(${-CX} ${-CY})`,
    )

    /* 地面阴影：跟随跳跃收缩、变淡。 */
    const lift = Math.max(0, -(sp.hy.x + dy - (scene.y ?? 0)))
    const shS = clamp(1 - lift / 140, 0.5, 1.2) * S
    setAttr(shadowEl, 'cx', CX + sp.hx.x * 0.85)
    setAttr(shadowEl, 'rx', 74 * shS)
    setAttr(shadowEl, 'ry', 10 * shS)
    setAttr(shadowEl, 'opacity', (0.16 * clamp(1 - lift / 120, 0.35, 1)).toFixed(3))

    setAttr(blushEl, 'opacity', (live.blush * 0.6).toFixed(3))

    /* 眼睛：球面投影 + 眨眼/垂目/放大。 */
    const morphMoving = Math.abs(sp.morph.x - sp.morph.t) > 0.0008 || Math.abs(sp.morph.v) > 0.004
    const rings = currentRings()
    const eyeInfo: Array<{ y: number; bl: number; ta: number } | null> = [null, null]
    const open = openness()
    const turnAll = sp.turn.x + gturn
    const gxU = sp.gx.x * 13.2
    const gyU = sp.gy.x * 8.4
    const wk = 1 + clamp((Math.abs(sp.gx.v) + Math.abs(sp.gy.v)) * 0.05, 0, 0.07)
    for (const [i, ring] of rings.entries()) {
      const el = eyeEls[i === 0 ? 0 : 1]
      let cx = 0
      let cy = 0
      let botY = -1e9
      for (const p of ring) {
        cx += p[0]
        cy += p[1]
        if (p[1] > botY) {
          botY = p[1]
        }
      }
      cx /= ring.length
      cy /= ring.length
      const baseLong = Math.asin(clamp((cx - CX) / R, -1, 1))
      const long = baseLong + turnAll
      const depth = Math.cos(long)
      const persp = Math.max(depth, 0.02) / Math.max(Math.cos(baseLong), 0.02)
      const ex = CX + R * Math.sin(long) + gxU
      const ey = cy + gyU
      const sx = clamp(persp * sp.es.x * wk, 0.02, 2.6)
      /* 双枚轴：尺寸缩放绕眼心，眨眼/垂目绕下眼睑线收合。 */
      const sLid = clamp(open * winkEnv(i) * live.droop, 0.02, 1.1)
      const sSize = clamp(sp.es.x * wk, 0.05, 2.6)
      const py = cy + (botY - cy) * 0.78
      const dY = sSize * sLid
      const fY = ey - cy + py + sLid * (cy * (1 - sSize) - py)
      if (morphMoving || pathDirty) {
        setAttr(el, 'd', ringPathD(ring))
      }
      setAttr(
        el,
        'transform',
        `matrix(${sx.toFixed(4)} 0 0 ${dY.toFixed(4)} ${(ex - sx * cx).toFixed(3)} ${fY.toFixed(3)})`,
      )
      el.style.opacity = depth > 0.02 ? '1' : '0'
      eyeInfo[i] = { y: ey, bl: baseLong, ta: turnAll }
    }
    pathDirty = morphMoving

    /* 腮红固定在脸颊经线上，随球面转头投影，不滑出脸缘。 */
    if (live.blush > 0.01) {
      for (const [i, blush] of blushEls.entries()) {
        const e = eyeInfo[i]
        if (e === null || e === undefined) {
          continue
        }
        const side = e.bl >= 0 ? 1 : -1
        const bBase = e.bl + side * 0.16
        const bLong = bBase + e.ta
        const bd = Math.cos(bLong)
        const bp = Math.max(bd, 0.02) / Math.max(Math.cos(bBase), 0.02)
        const bx = CX + R * 0.94 * Math.sin(bLong)
        setAttr(
          blush,
          'transform',
          `translate(${bx.toFixed(2)} ${(e.y + 33).toFixed(2)}) scale(${Math.max(bp * 0.9, 0.05).toFixed(3)} 1)`,
        )
        blush.style.opacity = clamp((bd - 0.1) / 0.32, 0, 1).toFixed(3)
      }
    }

    /* 轨道星子：倾斜轨道面 + 星形头自旋 + 彗尾拖影（前/后景深）。 */
    if (live.dots > 0.01) {
      const orx = 141 * S
      const ory = 44
      const ct = 0.988
      const st = -0.156
      for (const [i, o] of orbiters.entries()) {
        const a = ph.orbit + (i * TAU) / 3
        const sd = Math.sin(a)
        const ex0 = Math.cos(a) * orx
        const ey0 = sd * ory
        const hs = 1.12 * (0.74 + 0.34 * sd)
        setAttr(
          o.head,
          'transform',
          `translate(${(x + ex0 * ct - ey0 * st).toFixed(2)} ${(y + 26 + ex0 * st + ey0 * ct).toFixed(2)}) rotate(${((a * 86) % 360).toFixed(1)}) scale(${hs.toFixed(3)})`,
        )
        o.head.style.opacity = (0.62 + 0.38 * sd).toFixed(3)
        for (const [k, tr] of o.trail.entries()) {
          const ak = a - (k + 1) * 0.1
          const sk = Math.sin(ak)
          const tx0 = Math.cos(ak) * orx
          const ty0 = sk * ory
          setAttr(tr.el, 'cx', (x + tx0 * ct - ty0 * st).toFixed(2))
          setAttr(tr.el, 'cy', (y + 26 + tx0 * st + ty0 * ct).toFixed(2))
          setAttr(tr.el, 'r', (tr.r * (0.72 + 0.34 * sk)).toFixed(2))
          tr.el.style.opacity = (tr.o * (0.5 + 0.5 * sk)).toFixed(3)
        }
        o.g.style.opacity = live.dots.toFixed(3)
        const wantFront = sd > 0.04
        if (wantFront !== (o.g.parentNode === fxFront)) {
          ;(wantFront ? fxFront : fxBack).appendChild(o.g)
        }
      }
    } else {
      for (const o of orbiters) {
        o.g.style.opacity = '0'
      }
    }
  }

  /* ===== 互动。 ===== */
  function react() {
    if (sceneName === 'shy') {
      burst(3, 'heart')
      play(G.peekTurn(-0.3))
      return
    }
    if (sceneName === 'sleepy' || sceneName === 'sad') {
      play(G.wake())
      blink('quick', true)
      setExpression(sceneName === 'sleepy' ? 3 : 0)
      return
    }
    if (sceneName === 'hello') {
      wink()
      return
    }
    pick([
      () => {
        play(G.hop(18))
        setExpression(pick([2, 17, 11]))
      },
      () => play(G.spin(pick([-1, 1]))),
      () => {
        play(G.recoil())
        sp.es.x = 1.35
        blinkHoldUntil = tNow + 0.7
        dblBlinkAt = tNow + 0.75
      },
      () => {
        burst(9, 'sparkle')
        play(G.hop(12))
      },
      () => {
        burst(2, 'heart')
        play(G.hop(10))
        setExpression(2)
      },
    ])()
  }

  let pressed = false
  const onPointerDown = () => {
    pressed = true
    sp.press.t = -0.06
  }
  const onPointerUp = () => {
    if (!pressed) {
      return
    }
    pressed = false
    sp.press.t = 0
    react()
  }
  const onPointerCancel = () => {
    pressed = false
    sp.press.t = 0
  }
  root.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)

  /* 标签页隐藏期间 rAF 停摆，回来时重置时钟，免得 dt 巨大。 */
  const onVisibilityChange = () => {
    if (!document.hidden) {
      last = performance.now() / 1000
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  /* ===== 开场：睁开眼睛、伸个懒腰、左右看看。 ===== */
  const intro: Array<[number, () => void]> = []
  setScene('idle', { silent: true })
  if (!RM) {
    sp.open.x = 0
    sp.open.t = 0
    blinkHoldUntil = tNow + 1.3
    const t0 = tNow
    intro.push(
      [
        t0 + 0.45,
        () => {
          sp.open.t = 1
          play(G.wake())
        },
      ],
      [t0 + 1.35, () => blink('quick', true)],
      [
        t0 + 1.75,
        () => {
          gazeT = { x: -0.45, y: -0.12 }
          nextGaze = t0 + 2.6
        },
      ],
      [
        t0 + 2.35,
        () => {
          gazeT = { x: 0.42, y: -0.06 }
          nextGaze = t0 + 3.2
        },
      ],
    )
  }
  /* 初始就开着巡演时，等开场小动画演完再启动（原嵌入桥的 3.2s 延迟）。 */
  if (options.tour) {
    tourOn = true
    tourAt = tNow + 3.2
  }

  let rafId = 0
  const frame = (now: number) => {
    tNow = now / 1000
    const dt = Math.min(Math.max(tNow - last, 0.0005), 0.05)
    last = tNow
    step(dt)
    render()
    rafId = window.requestAnimationFrame(frame)
  }
  last = performance.now() / 1000
  tNow = last
  rafId = window.requestAnimationFrame(frame)

  return {
    setScene,
    setTour(on: boolean) {
      if (on === tourOn) {
        return
      }
      tourOn = on
      if (on) {
        tourIdx = sceneName === null ? 0 : Math.max(0, TOUR.indexOf(sceneName))
        tourAt = tNow + 0.01
      } else {
        tourAt = Number.POSITIVE_INFINITY
      }
    },
    setFollow(on: boolean) {
      follow = on
    },
    pointerMoved(clientX: number, clientY: number) {
      const rect = root.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const rx = Math.max(220, Math.min(window.innerWidth * 0.55, 520))
      const ry = Math.max(200, Math.min(window.innerHeight * 0.55, 420))
      pointer.x = clamp((clientX - centerX) / rx, -1, 1)
      pointer.y = clamp((clientY - centerY) / ry, -1, 1)
      pointer.at = performance.now() / 1000
    },
    dispose() {
      window.cancelAnimationFrame(rafId)
      root.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      fxBack.replaceChildren()
      fxFront.replaceChildren()
    },
  }
}
