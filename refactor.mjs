#!/usr/bin/env node
/*
 * 吉祥物去 iframe 化：apps/desktop/public/mascot.html 的动画引擎收编为
 * packages/agent-ui 的行内 SVG 组件，删除 iframe 载体与 postMessage 桥。
 * 幂等：每步先探测目标态，已完成即跳过；锚点缺失立即报错退出，绝不静默。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const HTML = 'apps/desktop/public/mascot.html'
const PUBLIC_DIR = 'apps/desktop/public'
const MASCOT_DIR = 'packages/agent-ui/src/surface/mascot'
const EXPRESSIONS_TS = `${MASCOT_DIR}/expressions.ts`
const ENGINE_TS = `${MASCOT_DIR}/engine.ts`
const BADGE_TSX = `${MASCOT_DIR}/mascot-badge.tsx`
const TEST_TS = `${MASCOT_DIR}/expressions.test.ts`
const OLD_BADGE = 'packages/agent-ui/src/surface/mascot.tsx'
const SURFACE = 'packages/agent-ui/src/surface/assistant-surface.tsx'
const CSS = 'packages/agent-ui/src/surface/assistant.css'

function fail(message) {
  console.error(`refactor: ${message}`)
  process.exit(1)
}

async function writeIfChanged(file, content) {
  if (existsSync(file) && (await readFile(file, 'utf8')) === content) {
    console.log(`skip  ${file}`)
    return
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  console.log(`write ${file}`)
}

if (!existsSync('pnpm-workspace.yaml')) {
  fail('请在仓库根目录运行（未找到 pnpm-workspace.yaml）')
}

/* ============ 1. 形状数据：从 mascot.html 机械提取 ============ */

async function buildExpressionsModule() {
  if (!existsSync(HTML)) {
    fail(`${EXPRESSIONS_TS} 缺失且 ${HTML} 已不存在，无处提取形状数据`)
  }
  const html = await readFile(HTML, 'utf8')
  const anchor = 'const EXPRESSIONS = '
  const start = html.indexOf(anchor)
  if (start === -1) {
    fail(`锚点「${anchor}」在 ${HTML} 中未找到`)
  }
  const lineEnd = html.indexOf('\n', start)
  if (lineEnd === -1) {
    fail('EXPRESSIONS 字面量没有行尾')
  }
  const literal = html.slice(start + anchor.length, lineEnd).trim()
  let data
  try {
    data = JSON.parse(literal)
  } catch {
    fail('EXPRESSIONS 字面量不是合法 JSON，提取中止')
  }
  if (!Array.isArray(data) || data.length !== 25) {
    fail(`EXPRESSIONS 应为 25 组表情，实际 ${Array.isArray(data) ? data.length : typeof data}`)
  }
  for (const pair of data) {
    const ok =
      Array.isArray(pair) &&
      pair.length === 2 &&
      pair.every(
        (ring) =>
          Array.isArray(ring) &&
          ring.length === 48 &&
          ring.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)),
      )
    if (!ok) {
      fail('EXPRESSIONS 违反「每组两环、每环 48 点」不变量，提取中止')
    }
  }
  const single = (re, label) => {
    const matches = [...html.matchAll(re)]
    if (matches.length !== 1) {
      fail(`锚点 ${label} 命中 ${matches.length} 次（应恰好 1 次）`)
    }
    return matches[0][1]
  }
  const bodyD = single(/<path class="body" d="([^"]+)" id="body" \/>/g, 'body path')
  const starD = single(/const STAR_D = '([^']+)'/g, 'STAR_D')
  const heartD = single(/const HEART_D = '([^']+)'/g, 'HEART_D')
  return `/*
 * 吉祥物的形状资产：25 组表情（每组左右两环、每环 48 点）、身体轮廓与
 * 粒子字形。引擎按「环长一致」逐点插值，expressions.test.ts 守这条契约。
 */

export type MascotPoint = readonly [number, number]
export type MascotRing = readonly MascotPoint[]
export type MascotExpression = readonly [MascotRing, MascotRing]

export const BODY_D =
  '${bodyD}'

export const STAR_D = '${starD}'

export const HEART_D =
  '${heartD}'

export const EXPRESSIONS: readonly MascotExpression[] = ${literal}
`
}

if (existsSync(EXPRESSIONS_TS)) {
  console.log(`skip  ${EXPRESSIONS_TS}`)
} else {
  await writeIfChanged(EXPRESSIONS_TS, await buildExpressionsModule())
}

/* ============ 2. 引擎：类型化移植（物理与数据流一字不改） ============ */

const ENGINE = `import type { MascotExpression, MascotRing } from './expressions'
import { EXPRESSIONS, HEART_D, STAR_D } from './expressions'

/*
 * 吉祥物动画引擎：弹簧物理 + 相位连续振荡器 + 加性一次性手势，每帧单向
 * 写入宿主 <svg> 的 data-part 部件。输入只有显式句柄（setTour / setFollow /
 * pointerMoved），输出只有 SVG 属性，因此可脱离 React 壳单独驱动与测试。
 */

export interface MascotOptions {
  readonly tour: boolean
  readonly follow: boolean
}

export interface MascotHandle {
  readonly setTour: (on: boolean) => void
  readonly setFollow: (on: boolean) => void
  readonly pointerMoved: (clientX: number, clientY: number) => void
  readonly dispose: () => void
}

const CX = 114.2705
const CY = 114.2705
const R = 105
const TAU = Math.PI * 2
const SVG_NS = 'http://www.w3.org/2000/svg'

type Pair = readonly [number, number]
type Curve = (t: number) => number
type MutablePoint = [number, number]
type MutableRing = MutablePoint[]

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const easeIO: Curve = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const easeOut: Curve = (t) => 1 - (1 - t) ** 3

const pick = <T>(arr: readonly T[]): T => {
  const v = arr[Math.floor(Math.random() * arr.length)]
  if (v === undefined) {
    throw new Error('mascot: pick on empty list')
  }
  return v
}

const setAttr = (el: Element, name: string, value: string | number): void => {
  el.setAttribute(name, String(value))
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
    const w = this.f
    this.v += (-2 * this.z * w * this.v - w * w * (this.x - this.t)) * dt
    this.x += this.v * dt
    if (!Number.isFinite(this.x)) {
      this.x = this.t
      this.v = 0
    }
    return this.x
  }
}

/* 关键帧采样器：手势曲线的形状。 */
const kf = (pts: readonly Pair[], ease: Curve = easeIO): Curve => {
  return (t) => {
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (first === undefined || last === undefined) {
      throw new Error('mascot: empty keyframe curve')
    }
    if (t <= first[0]) {
      return first[1]
    }
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1]
      const b = pts[i]
      if (a !== undefined && b !== undefined && t <= b[0]) {
        return lerp(a[1], b[1], ease((t - a[0]) / (b[0] - a[0])))
      }
    }
    return last[1]
  }
}

interface Gesture {
  readonly dur: number
  readonly big?: boolean
  readonly dy?: Curve
  readonly rot?: Curve
  readonly sq?: Curve
  readonly sc?: Curve
  readonly turn?: Curve
}

/* 手势库：叠加式一次性动作，进出平滑。 */
const G = {
  hop: (h = 16): Gesture => ({
    dur: 0.62,
    big: true,
    dy: kf([[0, 0], [0.1, 2.5], [0.36, -h], [0.6, 1], [0.8, -1.5], [1, 0]]),
    sq: kf([[0, 0], [0.1, -0.11], [0.3, 0.16], [0.5, 0.02], [0.63, -0.14], [0.82, 0.06], [1, 0]]),
  }),
  spin: (dir = 1): Gesture => ({
    dur: 0.9,
    big: true,
    turn: kf([[0, 0], [1, dir * TAU]]),
    sq: kf([[0, 0], [0.4, 0.08], [1, 0]]),
  }),
  recoil: (): Gesture => ({
    dur: 0.75,
    big: true,
    dy: kf([[0, 0], [0.12, -13], [0.42, -8], [0.75, 1.5], [1, 0]]),
    rot: kf([[0, 0], [0.12, -5], [0.5, -2.5], [1, 0]]),
    sq: kf([[0, 0], [0.1, 0.15], [0.4, 0.04], [0.6, -0.07], [1, 0]]),
  }),
  nod2: (): Gesture => ({
    dur: 0.85,
    dy: kf([[0, 0], [0.18, 3.2], [0.36, 0], [0.56, 3.2], [0.76, 0], [1, 0]]),
  }),
  tilt: (deg = 7): Gesture => ({
    dur: 1.15,
    rot: kf([[0, 0], [0.28, deg], [0.72, deg], [1, 0]]),
  }),
  lean: (): Gesture => ({
    dur: 1,
    big: true,
    sc: kf([[0, 0], [0.3, 0.05], [0.72, 0.05], [1, 0]]),
    dy: kf([[0, 0], [0.3, 1.6], [0.72, 1.6], [1, 0]]),
  }),
  sink: (): Gesture => ({
    dur: 2.4,
    big: true,
    dy: kf([[0, 0], [0.55, 9], [0.66, 10], [0.74, -4], [0.88, 1], [1, 0]]),
    rot: kf([[0, 0], [0.55, 4.5], [0.7, 4.5], [0.85, 0], [1, 0]]),
  }),
  peekTurn: (a = -0.42): Gesture => ({
    dur: 1.8,
    turn: kf([[0, 0], [0.25, a], [0.7, a], [1, 0]]),
  }),
  wake: (): Gesture => ({
    dur: 1.4,
    big: true,
    dy: kf([[0, 4], [0.3, 5], [0.55, -13], [0.75, 1], [1, 0]]),
    sq: kf([[0, -0.1], [0.3, -0.12], [0.5, 0.15], [0.72, -0.05], [1, 0]]),
  }),
}

type BlinkKind = 'quick' | 'soft' | 'sleepy'
type GazeMode = 'wander' | 'watch' | 'upthink' | 'read' | 'away' | 'down' | 'circle'
type ParticleShape = 'rect' | 'circle' | 'star' | 'heart'
type ParticleKind = 'confetti' | 'sparkle' | 'heart'

interface GazeSpec {
  readonly mode: GazeMode
  readonly every: Pair
  readonly ax?: number
  readonly ay?: number
  readonly ox?: number
  readonly oy?: number
}

interface PhysSpec {
  readonly mf?: number
  readonly mz?: number
  readonly hf?: number
  readonly hz?: number
  readonly gf?: number
}

interface SceneSpec {
  readonly pool: readonly number[]
  readonly expr: Pair
  readonly blink?: Pair
  readonly bKind?: BlinkKind
  readonly gaze: GazeSpec
  readonly mw?: number
  readonly tempo?: number
  readonly y?: number
  readonly rotB?: number
  readonly turnB?: number
  readonly scale?: number
  readonly es?: number
  readonly blush?: number
  readonly droop?: number
  readonly dots?: number
  readonly phys?: PhysSpec
  readonly breath: Pair
  readonly bob: Pair
  readonly sway: Pair
  readonly nod: Pair
  readonly tick?: (dt: number) => void
  readonly enter?: () => void
  readonly micro?: { readonly every: Pair; readonly run: () => void }
}

type SceneName =
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

interface ParticleNode {
  readonly el: SVGElement
  readonly shape: ParticleShape
  free: boolean
}

interface ParticleSpawn {
  readonly shape: ParticleShape
  readonly color: string
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly life: number
  readonly g?: number
  readonly drag?: number
  readonly vr?: number
  readonly wob?: number
  readonly wobF?: number
  readonly tw?: number
  readonly size?: number
}

interface Particle {
  readonly n: ParticleNode
  age: number
  rot: number
  x: number
  y: number
  vx: number
  vy: number
  readonly life: number
  readonly g: number
  readonly drag: number
  readonly vr: number
  readonly wob: number
  readonly wobF: number
  readonly tw: number
  readonly size: number
}

interface Orbiter {
  readonly g: SVGElement
  readonly head: SVGElement
  readonly trail: ReadonlyArray<{ readonly el: SVGElement; readonly r: number; readonly o: number }>
}

interface EyeInfo {
  readonly y: number
  readonly bl: number
  readonly ta: number
}

const P_COLORS = ['#5E9FE8', '#EAC26B', '#72BC8F', '#BF8EDA', '#DE9255'] as const
const SPARKLE_COLORS = ['#EAC26B', '#5E9FE8', '#e8b54d', '#BF8EDA'] as const
const HEART_COLORS = ['#f095a8', '#ef8aa0', '#e8798f'] as const
const ORBIT_COLORS = ['var(--mascot-star-1)', 'var(--mascot-star-2)', 'var(--mascot-star-3)'] as const
const TRAIL_SPECS = [
  { r: 2.7, o: 0.45 },
  { r: 1.85, o: 0.24 },
  { r: 1.15, o: 0.11 },
] as const

export function mountMascot(root: SVGSVGElement, options: MascotOptions): MascotHandle {
  const part = (name: string): SVGElement => {
    const el = root.querySelector(\`[data-part='\${name}']\`)
    if (el instanceof SVGElement) {
      return el
    }
    throw new Error(\`mascot: missing part \${name}\`)
  }
  const rig = part('rig')
  const shadowEl = part('shadow')
  const blushGroup = part('blush')
  const fxBack = part('fx-back')
  const fxFront = part('fx-front')
  const eyeList = [...root.querySelectorAll('[data-part=eye]')].filter(
    (el): el is SVGPathElement => el instanceof SVGPathElement,
  )
  const blushList = [...blushGroup.querySelectorAll('ellipse')]
  const eye0 = eyeList[0]
  const eye1 = eyeList[1]
  const blush0 = blushList[0]
  const blush1 = blushList[1]
  if (eye0 === undefined || eye1 === undefined || blush0 === undefined || blush1 === undefined) {
    throw new Error('mascot: skeleton needs two eyes and two blush marks')
  }
  const eyes = [eye0, eye1] as const
  const blushes = [blush0, blush1] as const
  const doc = root.ownerDocument

  const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const AMP = RM ? 0.35 : 1

  let tNow = performance.now() / 1000
  let last = tNow

  const gestures: Array<Gesture & { t0: number }> = []
  const play = (g: Gesture): void => {
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
  const springList: readonly Spring[] = Object.values(sp)

  /* 相位连续的全局振荡器：频率/振幅平滑过渡，相位永不重置。 */
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
  let burstKind: ParticleKind = 'sparkle'
  let burstN = 8
  let hopAt = Number.POSITIVE_INFINITY
  let dblBlinkAt = Number.POSITIVE_INFINITY
  let esSoftAt = Number.POSITIVE_INFINITY
  let flourishAt = Number.POSITIVE_INFINITY
  let thinkSide = 1
  let curSide = 1
  let readCol = -0.5
  let winkT0 = -9
  let winkEye: 0 | 1 = 1
  let winkAt = Number.POSITIVE_INFINITY
  let blinkAnim: { t0: number; kind: B