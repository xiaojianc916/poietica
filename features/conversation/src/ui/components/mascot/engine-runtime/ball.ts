/* ============================================================
 * 渲染层（纯渲染，不含业务逻辑）
 *
 *   坐标系：viewBox -15 -15 259 259，头部中心 HEAD_C = 114.2705
 *   身体：形状轮廓环（blob 圆胖 / wedge 三角 / gem 菱形）折线路径
 *   眼睛：25 组表情眼环（48 点轮廓），由 engine 逐点插值后传入，
 *        本层负责球面投影、变换与 path 更新
 *   球面投影：按眼睛当前高度采样身体轮廓的局部半宽，经度换算 + 余弦压缩，
 *            自旋偏航时眼睛绕到背面自动隐藏（cos <= 0.02 判定）
 *   彩带：两种形态 ——
 *        自旋甩带（角速度达阈值时甩出、减速后回缩的 3D 轨道拖尾）
 *        常驻环带（低倾角水平轨道持续环绕，用于"思考中"等状态）
 *        均使用 5-stop 色相漂移渐变 + 头宽尾细轮廓 + 圆头封口
 *   撒花：一次性物理粒子（速度衰减 + 微重力 + 金色五角星混入）
 *   zzz：睡眠状态右上角循环漂浮的字母粒子
 *
 * 由上游 emotion-ball 的 ball.js 逐字迁入：IIFE 拆为模块、window.EB_RINGS 改为
 * import，其余未改；类型只补在函数签名与缓存结构上。
 * ============================================================ */

import type { RingPoint } from './rings'
import { EB_RINGS } from './rings'
import type { BallHandle, BallOptions, BodyPose, EyeNode, EyePose, Pose } from './types'

/* 本层内部形状：只在 ball 内部流转，不属于与 engine 之间的契约，故不进 types.ts */
/** 轨道面（倾角 + 滚转） */
interface TrailPlane {
  tilt: number
  roll: number
}
/** 拖尾 / 环带共用的 3D 轨道参数，逐帧积分 */
interface Orbit {
  lam: number
  lamVel: number
  tilt: number
  roll: number
  rad: number
  radVel: number
  follow: number
  carry: number
  arc: number
}
/** 轨道采样点：z 决定前 / 后景分段，l 记录经度供回缩裁剪 */
interface OrbitSample {
  x: number
  y: number
  z: number
  l: number
}
/** 一条彩带的运行时状态 */
interface Trail {
  o: Orbit
  r: number
  life: number
  ret: number
  hist: OrbitSample[]
  orbitMode: boolean
  hue: number
  hueSpan: number
  hueVel: number
  gradEl: SVGLinearGradientElement
  stops: SVGStopElement[]
  back: SVGPathElement
  front: SVGPathElement
}
/** createTrail 的入参：o 由调用方按各自模式填好 */
interface TrailConfig {
  o: Orbit
  r: number
  hue: number
  orbit?: boolean
}
/** 撒花粒子 */
interface ConfettiPiece {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  r: number
  rot: number
  vr: number
  stretch: number
  el: SVGElement
}
/** 轮廓采样行 [minX, maxX] */
type SilRow = [number, number]
/** 左右眼下标写成字面量联合：元组按 0|1 取值才不会带上 undefined */
type EyeIndex = 0 | 1
/** SVG 属性值：text / rect 等调用点会传 number */
type SvgAttrs = Record<string, string | number>

const RD = EB_RINGS
/* 必须是字面量类型才能命中 createElementNS 的泛型重载，否则只能拿到 Element，
 * 而 svg.style / head.style / path 句柄都要具体元素类型 */
const SVGNS = 'http://www.w3.org/2000/svg'
let uid = 0
const TAU = Math.PI * 2

const HEAD_C = RD.HEAD_C /* 114.2705 */
const EYE_HALF = RD.EYE_HALF /* 21 */
const EXPR = RD.EXPRESSIONS
const STAR_GOLD = RD.STAR_GOLD
const CONFETTI_COLORS = ['#f9705c', '#5b95f0', '#3fbe86', '#f5b13f', '#9a72ee', '#35c3bd']
/* 五角星 path（内径比 0.42） */
const STAR_PATH = ((): string => {
  const pts: string[] = []
  for (let e = 0; e < 10; e++) {
    const a = -Math.PI / 2 + (e * Math.PI) / 5
    const r = e % 2 === 0 ? 1 : 0.42
    pts.push(`${(Math.cos(a) * r).toFixed(3)} ${(Math.sin(a) * r).toFixed(3)}`)
  }
  return `M${pts.join('L')}Z`
})()

/* 返回值随 tag 收窄：本层依赖 svg 的 style、path 的 d、stop / gradient 的属性更新 */
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: SvgAttrs): SVGElementTagNameMap[K]
function el(tag: keyof SVGElementTagNameMap, attrs: SvgAttrs): SVGElement {
  const node = document.createElementNS(SVGNS, tag)
  for (const k in attrs) node.setAttribute(k, String(attrs[k]))
  return node
}
function r2(v: number): number {
  return Math.round(v * 100) / 100
}
function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v
}
function rand(a: number, b: number): number {
  return a + Math.random() * (b - a)
}
function shade(hex: string, amt: number): string {
  let h = hex.replace('#', '')
  /* 长度 3 时下标 0..2 一定存在（钳位逻辑与上游一致），展开成 6 位 */
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  const n = parseInt(h, 16)
  let r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255
  const target = amt < 0 ? 0 : 255
  const a = Math.abs(amt)
  r = Math.round(r + (target - r) * a)
  g = Math.round(g + (target - g) * a)
  b = Math.round(b + (target - b) * a)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/* 轮廓环 → 闭合折线 path；48 点密度下视觉平滑 */
function ringPath(ring: readonly RingPoint[]): string {
  let s = 'M'
  for (let i = 0; i < ring.length; i++) {
    /* i 由循环上界保证落在环内 */
    s += `${(i ? 'L' : '') + ring[i]![0].toFixed(2)} ${ring[i]![1].toFixed(2)}`
  }
  return `${s}Z`
}
function centroid(ring: readonly RingPoint[]): RingPoint {
  let x = 0,
    y = 0
  for (let i = 0; i < ring.length; i++) {
    x += ring[i]![0]
    y += ring[i]![1]
  }
  return [x / ring.length, y / ring.length]
}

/** 建球：把 SVG 骨架挂进 container，返回句柄 */
export function createBall(container: Element, opts: BallOptions): BallHandle {
  opts = opts || {}
  const id = `eb${uid++}`
  const lite = !!opts.lite
  /* 未指定形状时上游取的是 SHAPES[undefined]（undefined）再回落 blob，这里等价展开 */
  const shape = (opts.shape ? RD.SHAPES[opts.shape] : undefined) || RD.SHAPES.blob
  const face = shape.face
  const headRing = shape.ring

  /* ---- 形状轮廓采样：每 2px 一行的 [minX, maxX]，供眼睛贴合任意身体轮廓 ---- */
  let silMinY = 1e9,
    silMaxY = -1e9
  for (let i = 0; i < headRing.length; i++) {
    if (headRing[i]![1] < silMinY) silMinY = headRing[i]![1]
    if (headRing[i]![1] > silMaxY) silMaxY = headRing[i]![1]
  }
  const SIL_STEP = 2
  const silRows: SilRow[] = []
  /* 扫一条水平线求轮廓的局部半宽：与轮廓每条边求交，取 min/max */
  function scanRow(y: number): SilRow {
    let lo = 1e9,
      hi = -1e9
    for (let e = 0; e < headRing.length; e++) {
      /* e 在环内，e+1 取模后也在环内 */
      const a = headRing[e]!,
        b = headRing[(e + 1) % headRing.length]!
      const y0 = a[1],
        y1 = b[1]
      if ((y0 <= y && y1 >= y) || (y1 <= y && y0 >= y)) {
        const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0)
        const x = a[0] + (b[0] - a[0]) * t
        if (x < lo) lo = x
        if (x > hi) hi = x
      }
    }
    /* 该行没扫到交点（形状的凹处）：退化成头心附近一小段，与上游一致 */
    return lo > hi ? [HEAD_C - 4, HEAD_C + 4] : [lo, hi]
  }
  ;(function buildSil(): void {
    const rows = Math.ceil((silMaxY - silMinY) / SIL_STEP) + 1
    for (let r = 0; r < rows; r++) silRows.push(scanRow(silMinY + r * SIL_STEP))
  })()
  function silAt(y: number): SilRow {
    const r = Math.round((clamp(y, silMinY, silMaxY) - silMinY) / SIL_STEP)
    /* r 已被 clamp 到 [0, 行数-1]，行一定存在（rows 至少 1 行） */
    return silRows[clamp(r, 0, silRows.length - 1)]!
  }

  /* ---- SVG 骨架 ---- */
  const svg = el('svg', {
    viewBox: '-15 -15 259 259',
    width: '100%',
    height: '100%',
    role: 'img',
    /* label 走 opts 的透传索引签名，String() 与 setAttribute 的隐式转换一致 */
    'aria-label': String(opts.label || 'AI 表情小球'),
  })
  svg.style.display = 'block'
  svg.style.overflow = 'visible'

  const defs = el('defs', {})
  const grad = el('radialGradient', { id: `${id}g`, cx: '38%', cy: '32%', r: '75%' })
  const stopA = el('stop', { offset: '0%' })
  const stopB = el('stop', { offset: '62%' })
  const stopC = el('stop', { offset: '100%' })
  grad.appendChild(stopA)
  grad.appendChild(stopB)
  grad.appendChild(stopC)
  defs.appendChild(grad)
  svg.appendChild(defs)

  const fxBack = el('g', { 'pointer-events': 'none' })
  svg.appendChild(fxBack)

  const bodyG = el('g', {})
  const head = el('path', { d: ringPath(headRing), fill: `url(#${id}g)`, stroke: 'none', 'stroke-width': '2' })
  bodyG.appendChild(head)

  function buildEye(k: EyeIndex): EyeNode {
    const node = el('path', { fill: '#1A1A1A', stroke: 'none', 'stroke-width': '1.6' })
    /* EXPR 是冻结的 25 组表情表，第 0 组恒存在；k 为 0|1，组内恒有左右两眼 */
    const ring = EXPR[0]![k]
    node.setAttribute('d', ringPath(ring))
    /* lastFill / lastStroke 初值 null 属于缓存初始态：首次 setEye 的取值一定不等于 null，
     * 与上游"字段未定义"时的行为一致 */
    return { node: node, ring: ring, c: centroid(ring), lastFill: null, lastStroke: null }
  }
  const eyeL = buildEye(0)
  const eyeR = buildEye(1)
  bodyG.appendChild(eyeL.node)
  bodyG.appendChild(eyeR.node)
  svg.appendChild(bodyG)

  const fxFront = el('g', { 'pointer-events': 'none' })
  svg.appendChild(fxFront)

  /* 眼睛基准中心：默认表情环的质心 */
  const BASE_C: readonly [RingPoint, RingPoint] = [centroid(EXPR[0]![0]), centroid(EXPR[0]![1])]

  /* ---- zzz 睡眠粒子：三枚字母沿右上方向循环漂浮 ---- */
  let zzzNodes: SVGTextElement[] | null = null
  if (!lite) {
    zzzNodes = []
    for (let zi = 0; zi < 3; zi++) {
      const zn = el('text', {
        x: 0,
        y: 0,
        fill: '#A8A296',
        opacity: '0',
        'font-family': "'Space Grotesk', 'Noto Sans SC', sans-serif",
        'font-weight': '700',
        'font-style': 'italic',
        'text-anchor': 'middle',
      })
      zn.textContent = 'z'
      fxFront.appendChild(zn)
      zzzNodes.push(zn)
    }
  }

  container.appendChild(svg)

  /* ---- 彩带：3D 轨道拖尾 ---- */
  const trails: Trail[] = []
  let planes: TrailPlane[] = []
  let planeG = 4
  let baseHue = 0
  let spawnAt: number[] = []
  let spawnIdx = 0
  let wasFast = false
  let prevYaw = 0,
    prevNow = 0
  let orbitNextAt = 0
  const confPieces: ConfettiPiece[] = []

  function makePlanes(): void {
    /* 多轨道面交错：2~3 个不同倾角 / 滚转的平面，彩带轮流落在各面上，
     * 甩出的弧线在多个角度方向上交错，而非单一平面里的一组平行弧 */
    planes = []
    const n = Math.random() < 0.45 ? 2 : 3
    const roll0 = rand(-0.9, 0.9)
    for (let pi = 0; pi < n; pi++) {
      planes.push({
        tilt: rand(0.16, 0.72),
        roll: roll0 + pi * (Math.PI / n) + rand(-0.15, 0.15),
      })
    }
    planeG = Math.round(rand(4, 6))
    baseHue = rand(0, 360)
    spawnIdx = 0
  }

  function orbitPoint(o: Orbit, lam: number): OrbitSample {
    const hx = o.rad * Math.sin(lam)
    const hy = -o.rad * Math.cos(lam) * Math.sin(o.tilt)
    const ca = Math.cos(o.roll),
      sa = Math.sin(o.roll)
    return {
      x: HEAD_C + hx * ca - hy * sa,
      y: HEAD_C + hx * sa + hy * ca,
      z: Math.cos(lam) * Math.cos(o.tilt),
      l: lam,
    }
  }

  /** 创建一条拖尾：独立 5-stop 渐变 + 前后两段 path */
  function createTrail(cfg: TrailConfig): void {
    if (trails.length > 8) return
    const gradEl = el('linearGradient', { id: `${id}tg${uid++}`, gradientUnits: 'userSpaceOnUse' })
    const stops: SVGStopElement[] = []
    for (let s = 0; s < 5; s++) {
      const st = el('stop', { offset: (s / 4).toFixed(3) })
      gradEl.appendChild(st)
      stops.push(st)
    }
    defs.appendChild(gradEl)
    const fill = `url(#${gradEl.getAttribute('id')})`
    const back = el('path', { stroke: 'none', fill: fill, opacity: '0' })
    const front = el('path', { stroke: 'none', fill: fill, opacity: '0' })
    fxBack.appendChild(back)
    fxFront.appendChild(front)
    trails.push({
      o: cfg.o,
      r: cfg.r,
      life: 0,
      ret: 0,
      hist: [],
      orbitMode: !!cfg.orbit,
      hue: cfg.hue,
      hueSpan: rand(45, 95) * (Math.random() < 0.5 ? 1 : -1),
      hueVel: rand(18, 42) * (Math.random() < 0.5 ? 1 : -1),
      gradEl: gradEl,
      stops: stops,
      back: back,
      front: front,
    })
  }

  /** 自旋甩带：沿本次自旋的多个轨道平面轮流错峰甩出 */
  function spawnTrail(lam0: number, dir: number): void {
    /* spawnAt 只在 makePlanes() 里被填充，因此本函数被调用时 planes 至少 1 个面；
     * 取模结果恒落在 [0, planes.length) */
    const pl = planes[spawnIdx % planes.length]!
    const tierStep = 38 / Math.max(planeG - 1, 1)
    const rw = planeG <= 3 ? rand(8, 10.5) : planeG === 4 ? rand(6.6, 8.6) : rand(5.6, 7.4)
    createTrail({
      o: {
        lam: lam0,
        lamVel: dir * rand(0.5, 1.1),
        tilt: pl.tilt + rand(-0.04, 0.04),
        roll: pl.roll + rand(-0.05, 0.05),
        rad: 116 + spawnIdx * tierStep + rand(-1.5, 1.5),
        radVel: rand(0, 2.5),
        follow: rand(0.74, 0.94),
        carry: 0,
        arc: rand(2.2, 3.4),
      },
      r: rw,
      hue: baseHue + (360 * spawnIdx) / Math.max(planeG, 1) + rand(-14, 14),
    })
    spawnIdx++
  }

  /** 常驻环带：低倾角水平轨道匀速环绕（"思考中"等状态的持续效果） */
  function spawnOrbit(idx: number): void {
    createTrail({
      orbit: true,
      o: {
        lam: rand(0, TAU),
        lamVel: (Math.random() < 0.5 ? -1 : 1) * rand(1.7, 2.3),
        tilt: rand(0.1, 0.22),
        roll: rand(-0.12, 0.12),
        rad: 124 + idx * 16,
        radVel: 0,
        follow: 0.8,
        carry: 0,
        arc: rand(2.4, 3.2),
      },
      r: rand(5.5, 7),
      hue: rand(0, 360),
    })
  }

  /* 拖尾轮廓：头宽尾细 + 首尾圆头封口，按 z 正负拆为前 / 后两段 */
  function buildTrail(pts: readonly OrbitSample[], width: number): { front: string; back: string } {
    const n = pts.length
    const nx: number[] = [],
      ny: number[] = []
    for (let e = 0; e < n; e++) {
      /* 首尾点取自身，保证端点法线可算；e 由循环上界保证在点列内 */
      const p0 = pts[e > 0 ? e - 1 : 0]!,
        p1 = pts[e < n - 1 ? e + 1 : n - 1]!
      let dx = p1.x - p0.x,
        dy = p1.y - p0.y
      const h = Math.hypot(dx, dy) || 1
      dx /= h
      dy /= h
      const d = (width * (0.5 + (e / (n - 1)) * 0.5)) / 2
      nx.push(-dy * d)
      ny.push(dx * d)
    }
    function cap(idx: number): string {
      const hw = Math.max(Math.hypot(nx[idx]!, ny[idx]!), 0.2)
      return `A${r2(hw)} ${r2(hw)} 0 0 0 `
    }
    function seg(a: number, b: number): string {
      let s = ''
      /* a <= b 且两点均落在 [0, n-1]（由 buildTrail 的主循环夹取） */
      for (let k = a; k <= b; k++) s += `${(k === a ? 'M' : 'L') + r2(pts[k]!.x + nx[k]!)} ${r2(pts[k]!.y + ny[k]!)}`
      s += b === n - 1 ? cap(b) : 'L'
      for (let k = b; k >= a; k--) s += `${(k === b ? '' : 'L') + r2(pts[k]!.x - nx[k]!)} ${r2(pts[k]!.y - ny[k]!)}`
      if (a === 0) s += `${cap(0) + r2(pts[0]!.x + nx[0]!)} ${r2(pts[0]!.y + ny[0]!)}`
      return `${s}Z`
    }
    let front = '',
      back = '',
      d0 = 0
    while (d0 < n) {
      const isF = pts[d0]!.z >= 0
      let i2 = d0
      while (i2 + 1 < n && pts[i2 + 1]!.z >= 0 === isF) i2++
      const a2 = Math.max(d0 - 1, 0),
        b2 = Math.min(i2 + 1, n - 1)
      if (b2 > a2) {
        const str = seg(a2, b2)
        if (isF) front += str
        else back += str
      }
      d0 = i2 + 1
    }
    return { front: front, back: back }
  }

  function removeTrail(idx: number): void {
    /* 调用点从 trails 的循环下标传入，恒在 [0, trails.length) */
    const rb = trails[idx]!
    rb.back.remove()
    rb.front.remove()
    rb.gradEl.remove()
    trails.splice(idx, 1)
  }

  /* ---- 撒花：一次性物理粒子爆发 ---- */
  function burst(count: number): void {
    if (lite) return
    count = count || 20
    for (let i = 0; i < count && confPieces.length < 60; i++) {
      const ang = (i / count) * TAU + rand(-0.35, 0.35)
      const spd = rand(170, 360)
      const star = Math.random() < 0.18
      const round = !star && Math.random() < 0.3
      let piece: SVGElement
      /* (random * len) | 0 恒落在 [0, len-1]（Math.random() < 1） */
      if (star) piece = el('path', { d: STAR_PATH, fill: STAR_GOLD })
      else if (round)
        piece = el('circle', { r: 1, fill: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0]! })
      else
        piece = el('rect', {
          x: -0.5,
          y: -0.5,
          width: 1,
          height: 1,
          rx: 0.24,
          fill: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0]!,
        })
      fxFront.appendChild(piece)
      confPieces.push({
        x: HEAD_C + Math.cos(ang) * rand(96, 116),
        y: HEAD_C + Math.sin(ang) * rand(96, 116),
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - rand(20, 75),
        life: 0,
        max: rand(0.45, 0.85),
        r: star ? rand(4, 7) : rand(3.5, 8),
        rot: rand(0, 360),
        vr: rand(-260, 260),
        stretch: !star && !round ? 1.9 : 1,
        el: piece,
      })
    }
  }

  /* ---- 状态缓存 ---- */
  let curBodyColor: string | null = null
  let curSketch = -1

  function setBodyColor(color: string): void {
    if (color === curBodyColor) return
    curBodyColor = color
    stopA.setAttribute('stop-color', shade(color, 0.22))
    stopB.setAttribute('stop-color', color)
    stopC.setAttribute('stop-color', shade(color, -0.12))
    if (curSketch > 0.5) head.style.stroke = `var(--sketch-ink, ${shade(color, -0.6)})`
  }

  /* ---- 眼睛：轮廓环形变 + 球面投影 ---- */
  function setEye(eye: EyeNode, pose: EyePose, k: EyeIndex, sketch: number, yaw: number): void {
    /* d 更新：engine 传入插值后的环（引用不变则跳过）。
     * 缩放锚点用当前环自身质心 —— 眼环位置烘焙在数据里（如检索环偏向一侧），
     * 绕默认质心缩放会把位置偏差放大导致眼睛飞出身体 */
    const ring = pose.ring
    if (ring && ring !== eye.ring) {
      eye.ring = ring
      eye.node.setAttribute('d', ringPath(ring))
      eye.c = centroid(ring)
    }

    const base = eye.c || BASE_C[k]
    const open = clamp(pose.open, 0.02, 2.4)
    const sy = clamp(pose.scaleY * open * face.eye, 0.02, 2.4)
    const sxBase = pose.scaleX * face.eye

    /* 纵向：脸部拟合映射 + 轮廓钳制 */
    const halfH = EYE_HALF * sy + 2
    let ey0 = HEAD_C + face.y + (base[1] - HEAD_C) * face.sy + pose.y + pose.lookY
    ey0 = clamp(ey0, silMinY + halfH, silMaxY - halfH)

    const sil = silAt(ey0)
    const cx0 = (sil[0] + sil[1]) / 2
    const hw = Math.max((sil[1] - sil[0]) / 2, 12)

    /* 横向：经度换算 + 自旋偏航 + 余弦压缩 */
    const ox = face.x + (base[0] - HEAD_C) * face.sx + pose.x + pose.lookX
    const theta = clamp(ox / hw, -1.15, 1.15)
    const total = theta + (yaw || 0)
    const cn = Math.cos(total)
    if (cn <= 0.02) {
      eye.node.style.display = 'none'
      return
    }
    eye.node.style.display = ''
    const ex = cx0 + hw * Math.sin(total) * 0.985
    const dyN = (ey0 - HEAD_C) / 130
    const fy = Math.sqrt(1 - dyN * dyN * 0.22)

    eye.node.setAttribute(
      'transform',
      'translate(' +
        r2(ex) +
        ' ' +
        r2(ey0) +
        ')' +
        (pose.rotate ? ` rotate(${r2(pose.rotate)})` : '') +
        ' scale(' +
        r2(sxBase * cn) +
        ' ' +
        r2(sy * fy) +
        ')' +
        ' translate(' +
        r2(-base[0]) +
        ' ' +
        r2(-base[1]) +
        ')',
    )

    const fill = sketch > 0.5 ? 'none' : pose.color
    /* 线稿眼描边同样走主题墨色：暗色页面用浅墨，避免深色瞳色几乎不可见 */
    const stroke = sketch > 0.5 ? `var(--sketch-ink, ${pose.color})` : ''
    if (fill !== eye.lastFill) {
      eye.node.setAttribute('fill', fill)
      eye.lastFill = fill
    }
    if (stroke !== eye.lastStroke) {
      eye.node.style.stroke = stroke
      eye.lastStroke = stroke
    }
  }

  /* ---- 每帧 ---- */
  /** zzz 睡眠粒子：三枚字母错峰沿右上方向漂浮，先淡入后淡出 */
  function updateZzz(now: number, b: BodyPose) {
    if (zzzNodes) {
      const zOn = (b.zzz || 0) > 0
      for (let z = 0; z < zzzNodes.length; z++) {
        /* z 由循环上界保证落在节点数组内 */
        const znode = zzzNodes[z]!
        if (!zOn) {
          if (znode.getAttribute('opacity') !== '0') znode.setAttribute('opacity', '0')
          continue
        }
        const zp = (now * 0.00033 + z / 3) % 1
        const zo = (zp < 0.18 ? zp / 0.18 : 1 - (zp - 0.18) / 0.82) * 0.8 * b.zzz
        znode.setAttribute('opacity', zo.toFixed(3))
        znode.setAttribute('font-size', (12 + zp * 11).toFixed(1))
        znode.setAttribute(
          'transform',
          'translate(' +
            r2(180 + zp * 34 + 4 * Math.sin(zp * 9)) +
            ' ' +
            r2(48 - zp * 42) +
            ')' +
            ' rotate(' +
            r2(-10 + zp * 14) +
            ')',
        )
      }
    }
  }

  /** 自旋角速度（甩带触发源） */
  function updateSpin(now: number, dt: number, yaw: number): { fast: boolean; dir: number; dYaw: number; vel: number } {
    let dYaw = yaw - prevYaw
    if (!Number.isFinite(dYaw) || Math.abs(dYaw) > 1.2) dYaw = 0
    prevYaw = yaw
    const vel = dYaw / dt
    const fast = Math.abs(vel) >= 0.9
    const dir = vel >= 0 ? 1 : -1

    if (fast && !wasFast) {
      makePlanes()
      spawnAt = []
      for (let q = 0; q < planeG; q++) spawnAt.push(now + q * rand(55, 105))
    }
    if (!fast) spawnAt.length = 0
    wasFast = fast
    if (Math.abs(vel) >= 5) {
      /* 循环条件已保证 spawnAt 非空 */
      while (spawnAt.length && now >= spawnAt[0]!) {
        spawnAt.shift()
        spawnTrail(yaw - rand(0, 0.18) * dir, dir)
      }
    }

    return { fast, dir, dYaw, vel }
  }

  /** 常驻环带补给：状态需要且数量不足时错峰生成 */
  function refillOrbit(now: number, b: BodyPose): boolean {
    const orbitWant = (b.orbit || 0) > 0
    if (orbitWant && now >= orbitNextAt) {
      let orbitCount = 0
      /* oc 由循环上界保证落在 trails 内 */
      for (let oc = 0; oc < trails.length; oc++) if (trails[oc]!.orbitMode) orbitCount++
      if (orbitCount < 2) spawnOrbit(orbitCount)
      orbitNextAt = now + 700
    }
    return orbitWant
  }

  /** 彩带逐帧更新 */
  function updateTrails(dt: number, fast: boolean, dir: number, dYaw: number, vel: number, orbitWant: boolean) {
    for (let ti = trails.length - 1; ti >= 0; ti--) {
      /* ti 由循环上界保证落在 trails 内（removeTrail 后立即 continue） */
      const rb = trails[ti]!
      rb.life += dt
      const retract = rb.orbitMode ? !orbitWant : !fast || rb.life > 5
      rb.ret = clamp(rb.ret + (retract ? dt / 0.5 : -dt / 0.35), 0, 1)
      if (retract && rb.ret >= 1) {
        removeTrail(ti)
        continue
      }
      const o = rb.o
      if (rb.orbitMode) {
        /* 环带：匀速环绕，叠加少量自旋跟随 */
        o.lam += o.lamVel * dt + dYaw * o.follow
      } else if (fast) {
        o.carry = vel * o.follow
        o.lam += dYaw * o.follow + o.lamVel * dt
      } else {
        o.lam += (o.carry + o.lamVel) * dt
        o.carry *= Math.exp(-2.6 * dt)
        o.lamVel *= Math.exp(-2.6 * dt)
      }
      o.rad += o.radVel * dt

      advanceTrailHistory(o, rb, dir)
      const hist = rb.hist
      const zHead = Math.cos(o.lam) * Math.cos(o.tilt)
      const pz = 0.72 + 0.28 * clamp(zHead, 0, 1)
      let grow = Math.min(rb.life / 0.34, 1)
      grow = grow * grow * (3 - 2 * grow)
      const width = rb.r * pz * 1.7 * grow * (1 - 0.72 * rb.ret * rb.ret)
      const fade = Math.min(rb.life / 0.26, 1).toFixed(3)

      if (hist.length < 2 || width < 0.5) {
        rb.back.setAttribute('opacity', '0')
        rb.front.setAttribute('opacity', '0')
        continue
      }
      const dstr = buildTrail(hist, width)
      rb.back.setAttribute('d', dstr.back)
      rb.front.setAttribute('d', dstr.front)
      rb.back.setAttribute('opacity', fade)
      rb.front.setAttribute('opacity', fade)

      paintTrailGradient(rb, hist)
    }
  }

  /** 拖尾点的弧长推进与回缩裁剪：把 rb.hist 维护成「以当前角为头、跨度不超过 span」的点列 */
  function advanceTrailHistory(o: Orbit, rb: Trail, dir: number): void {
    const hist = rb.hist
    /* hist 非空时末点一定存在；为空时回退到理论末位置 */
    const lastL = hist.length ? hist[hist.length - 1]!.l : o.lam - 0.001 * dir
    const dl = o.lam - lastL
    const steps = Math.min(Math.ceil(Math.abs(dl) / 0.09), 24)
    for (let st = 1; st <= steps; st++) hist.push(orbitPoint(o, lastL + (dl * st) / steps))
    if (!hist.length) hist.push(orbitPoint(o, o.lam))

    /* 回缩：smoothstep 弧长收窄 + 首点插值细修 + 上限 48 点 */
    const span = o.arc * (1 - rb.ret * rb.ret * (3 - 2 * rb.ret))
    while (hist.length > 2 && Math.abs(o.lam - hist[0]!.l) > span) hist.shift()
    const over = Math.abs(o.lam - hist[0]!.l) - span
    if (hist.length >= 2 && over > 0) {
      const tl = hist[0]!.l + (o.lam - hist[0]!.l >= 0 ? 1 : -1) * over
      hist[0] = orbitPoint(o, tl)
    }
    if (hist.length > 48) hist.splice(0, hist.length - 48)
  }

  /** 彩带渐变的 5 个 stop 与两端坐标：每次都跟随拖尾首尾 */
  function paintTrailGradient(rb: Trail, hist: OrbitSample[]): void {
    /* 5-stop 色相漂移渐变，端点跟随拖尾首尾 */
    const hue = rb.hue + rb.hueVel * rb.life
    for (let si = 0; si < rb.stops.length; si++) {
      /* si 由循环上界保证落在 stops 内 */
      const frac = si / (rb.stops.length - 1)
      const hv = hue + frac * rb.hueSpan
      rb.stops[si]!.setAttribute(
        'stop-color',
        `hsl(${(((hv % 360) + 360) % 360).toFixed(0)} 56% ${(56 + 11 * frac).toFixed(0)}%)`,
      )
    }
    /* 上面已按 hist.length < 2 提前 continue，首尾点一定存在 */
    const tail = hist[0]!,
      headP = hist[hist.length - 1]!
    rb.gradEl.setAttribute('x1', tail.x.toFixed(1))
    rb.gradEl.setAttribute('y1', tail.y.toFixed(1))
    rb.gradEl.setAttribute('x2', headP.x.toFixed(1))
    rb.gradEl.setAttribute('y2', headP.y.toFixed(1))
  }

  /** 撒花更新：速度衰减 0.94^60dt + 微重力 40/s */
  function updateConfetti(dt: number) {
    for (let ci = confPieces.length - 1; ci >= 0; ci--) {
      /* ci 由循环上界保证落在 confPieces 内（splice 后立即 continue） */
      const pc = confPieces[ci]!
      pc.life += dt
      if (pc.life >= pc.max) {
        pc.el.remove()
        confPieces.splice(ci, 1)
        continue
      }
      pc.x += pc.vx * dt
      pc.y += pc.vy * dt
      const drag = 0.94 ** (60 * dt)
      pc.vx *= drag
      pc.vy = pc.vy * drag + 40 * dt
      pc.rot += pc.vr * dt
      const u = pc.life / pc.max
      const fd = u < 0.1 ? u / 0.1 : (1 - (u - 0.1) / 0.9) ** 1.7
      const sz = Math.max(pc.r * (1 - 0.4 * u), 0.5)
      pc.el.setAttribute('opacity', fd.toFixed(3))
      pc.el.setAttribute(
        'transform',
        'translate(' +
          r2(pc.x) +
          ' ' +
          r2(pc.y) +
          ') rotate(' +
          r2(pc.rot) +
          ') scale(' +
          r2(sz) +
          ' ' +
          r2(sz * pc.stretch) +
          ')',
      )
    }
  }

  function applyPose(pose: Pose): void {
    const b = pose.body
    const now = performance.now()
    const sketch = b.sketch || 0

    bodyG.setAttribute(
      'transform',
      'translate(' +
        r2(HEAD_C + b.x) +
        ' ' +
        r2(HEAD_C + b.y) +
        ')' +
        ' rotate(' +
        r2(b.rotate || 0) +
        ')' +
        ' scale(' +
        r2(b.scale) +
        ')' +
        ' translate(' +
        r2(-HEAD_C) +
        ' ' +
        r2(-HEAD_C) +
        ')',
    )
    setBodyColor(b.color)

    if (sketch !== curSketch) {
      curSketch = sketch
      if (sketch > 0.5) {
        /* 线稿模式：描边优先取页面主题墨色 --sketch-ink（暗色页浅墨、亮色页深墨），
         * 无主题变量时回退体色加深 */
        head.setAttribute('fill', 'none')
        head.style.stroke = `var(--sketch-ink, ${shade(b.color, -0.6)})`
        head.setAttribute('stroke-opacity', '0.85')
      } else {
        head.setAttribute('fill', `url(#${id}g)`)
        head.style.stroke = ''
      }
    }

    const yaw = b.yaw || 0
    setEye(eyeL, pose.left, 0, sketch, yaw)
    setEye(eyeR, pose.right, 1, sketch, yaw)

    if (lite) return

    const dt = prevNow ? clamp((now - prevNow) / 1000, 0.001, 0.05) : 1 / 60
    prevNow = now

    updateZzz(now, b)
    /* 先算角速度：它决定彩带是否甩出、往哪个方向甩 */
    const spin = updateSpin(now, dt, yaw)
    const orbitWant = refillOrbit(now, b)
    updateTrails(dt, spin.fast, spin.dir, spin.dYaw, spin.vel, orbitWant)
    updateConfetti(dt)
  }

  function destroy(): void {
    if (svg.parentNode) svg.parentNode.removeChild(svg)
  }

  return { svg: svg, applyPose: applyPose, burst: burst, destroy: destroy }
}
