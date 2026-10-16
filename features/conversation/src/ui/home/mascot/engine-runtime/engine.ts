/* ============================================================
 * 驱动层（依赖 ball.ts；消费 emotions.ts 纯数据）
 *
 * 职责：
 *   1. 配置注册中心 config：校验 / 深合并默认值 / 导入导出
 *   2. EmotionEngine：rAF 状态机 + 动画原语 + 平滑插值 + 兜底 + 待机策略
 *   3. 对外 SDK：createEngine(el, opts) → engine 实例
 *
 * 对外 API（宿主工具只依赖这一层）：
 *   const ball = createEngine(el, { emotion:'02', idle:true })
 *   ball.setEmotion('30');
 *   ball.handleAIMessage({ emotionId:'30', tips:'正在思考' });   // 或 JSON 字符串
 *   ball.on('change'|'tips'|'error', cb);
 *   ball.startTour(ids, interval) / ball.stopTour();
 *   ball.registerEmotion(config); ball.destroy();
 *   config.exportConfig() / importConfig(json);
 *
 * 由上游 emotion-ball 的 engine.js 逐字迁入：IIFE 拆为模块，window 全局与
 * console 收口为 import + 注入 logger，种子配置直接取自数据层；算法未改。
 * ============================================================ */

import { invariant } from '@poietica/foundation'
import { createBall } from './ball'
import { EMOTION_GROUPS, EMOTION_SEED } from './emotions'
import type { EyeRing, RingPoint } from './rings'
import { EB_RINGS } from './rings'
import type {
  AnimSpec,
  BallHandle,
  BlinkKey,
  BodyPose,
  EmotionDef,
  EmotionRaw,
  EngineHandle,
  EngineLogger,
  EngineOptions,
  EyePose,
  IdlePolicy,
  NumericPosePart,
  Pose,
  PoseFrame,
  PoseSpec,
  SequenceState,
  Spring,
} from './types'

const RD = EB_RINGS
const EXPR = RD.EXPRESSIONS
const TAU = Math.PI * 2
const FALLBACK_ID = '02'

/* ---------------- 基础工具 ---------------- */

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
function rand(a: number, b: number): number {
  return a + Math.random() * (b - a)
}
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

/* 临界阻尼弹簧步进：springStep(spring, 频率, 阻尼比, dt)，子步 1/120 保证数值稳定 */
function spring(v0: number): Spring {
  return { x: v0, v: 0, t: v0 }
}
function springStep(s: Spring, w: number, z: number, dt: number): void {
  s.v += (-2 * z * w * s.v - w * w * (s.x - s.t)) * dt
  s.x += s.v * dt
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
    s.x = s.t
    s.v = 0
  }
}

/* 两组眼环逐点插值 */
function lerpRing(a: EyeRing, b: EyeRing, t: number): EyeRing {
  const out: RingPoint[] = new Array(a.length)
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]!,
      pb = b[i]!
    out[i] = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t]
  }
  return out
}

/* 弹跳：4 段递减抛物线（高度 48/28/14/6，时长 0.5/0.382/0.27/0.177s） */
const BOUNCE_SEGS = [
  { h: 48, d: 0.5 },
  { h: 28, d: 0.382 },
  { h: 14, d: 0.27 },
  { h: 6, d: 0.177 },
]
const BOUNCE_TOTAL = BOUNCE_SEGS.reduce((s, q) => s + q.d, 0)

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`
}
function lerpColor(a: string, b: string, t: number): string {
  if (a === b) return b
  const A = hexToRgb(a),
    B = hexToRgb(b)
  return rgbToHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t))
}

/* ---------------- Pose：默认值 / 合并 / 插值 ---------------- */

const DEFAULT_BODY: BodyPose = {
  x: 0,
  y: 0,
  scale: 1,
  rotate: 0,
  color: '#F3F0EA',
  breathe: 0.01,
  ribbons: 0,
  confetti: 0,
  sketch: 0,
  zzz: 0 /* 睡眠字母粒子（0~1） */,
  orbit: 0 /* 常驻水平环带（0~1） */,
  yaw: 0,
}
const DEFAULT_EYE: EyePose = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  open: 1,
  color: '#1A1A1A',
  lookX: 0,
  lookY: 0,
}

const PARTS = ['body', 'left', 'right'] as const

/* 眼环数据自带左右不对称，默认姿态不叠加高低差 */
function defaultPose(): Pose {
  return {
    body: Object.assign({}, DEFAULT_BODY),
    left: Object.assign({}, DEFAULT_EYE),
    right: Object.assign({}, DEFAULT_EYE),
  }
}
function clonePose(p: Pose): Pose {
  return {
    body: Object.assign({}, p.body),
    left: Object.assign({}, p.left),
    right: Object.assign({}, p.right),
  }
}

/** 把配置片段（body / eyes.both / eyes.left / eyes.right）合并到 pose 上（原地修改） */
function applySpec(pose: Pose, spec: PoseSpec | null | undefined): Pose {
  if (!spec) return pose
  if (spec.body) Object.assign(pose.body, spec.body)
  const e = spec.eyes
  if (e) {
    if (e.both) {
      Object.assign(pose.left, e.both)
      Object.assign(pose.right, e.both)
    }
    if (e.left) Object.assign(pose.left, e.left)
    if (e.right) Object.assign(pose.right, e.right)
  }
  return pose
}

/** 姿态字段的动态视图。
 *  上游用 for…in 按字段名读写姿态字段，TS 的具名接口表达不了这种动态访问（EyePose 还带 ring
 *  这种对象字段，加索引签名会连类型都收不回来）。这是全文件唯一一处类型逃逸，集中在这里。 */
/** 取字段的数值：数据层保证这些字段存在，undefined 只可能来自调用方传入的半成品姿态 */
function num(v: number | string | undefined): number {
  return typeof v === 'number' ? v : 0
}

function fieldsOf(part: BodyPose | EyePose): NumericPosePart {
  return part as unknown as NumericPosePart
}

/** 把单个字段从 pa 插值到 pb（原 lerpPose 内层循环体原样搬出） */
function lerpPoseField(po: NumericPosePart, pa: NumericPosePart, pb: NumericPosePart, k: string, t: number): void {
  const vb = pb[k]
  if (typeof vb === 'number') {
    const from = pa[k]
    po[k] = lerp(typeof from === 'number' ? from : vb, vb, t)
  } else if (k === 'color') {
    const from = pa[k]
    po[k] = lerpColor(typeof from === 'string' ? from : String(vb), String(vb), t)
  } else {
    /* 非数值字段（ring 这类对象引用）不过渡，原样直通 */
    po[k] = vb
  }
}

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const out = defaultPose()
  for (const part of PARTS) {
    const pa = fieldsOf(a[part])
    const pb = fieldsOf(b[part])
    const po = fieldsOf(out[part])
    for (const k of Object.keys(pb)) {
      lerpPoseField(po, pa, pb, k, t)
    }
  }
  return out
}

/* ---------------- 动画原语 ---------------- */

const ANIM_TYPES: Record<string, (a: AnimSpec, t: number, eng?: Engine) => number> = {
  /** 正弦漂移/呼吸/扫视 */
  sine: (a, t) => {
    return (a.amp ?? 0) * Math.sin((TAU * t) / (a.period || 2000) + (a.phase || 0))
  },
  /** 节奏缩放：0 → amp 平滑往复 */
  pulse: (a, t) => {
    return (a.amp ?? 0) * 0.5 * (1 - Math.cos((TAU * t) / (a.period || 1000) + (a.phase || 0)))
  },
  /** 随机小抖动（多正弦伪噪声），decay 毫秒内衰减到 0 */
  jitter: (a, t, eng) => {
    const s = (t / 1000) * (a.speed || 8)
    const seed = eng ? eng.seed : 0
    let v =
      ((Math.sin(s * 3.1 + seed) + Math.sin(s * 5.7 + seed * 2.3) + Math.sin(s * 9.3 + seed * 4.1)) / 3) * (a.amp ?? 0)
    if (a.decay) v *= clamp(1 - t / a.decay, 0, 1)
    return v
  },
  /** 三角波快速来回扫动 */
  scan: (a, t) => {
    const per = a.period || 800
    const p = ((t + (a.phaseMs || 0)) % per) / per
    const tri = p < 0.5 ? p * 4 - 1 : 3 - p * 4 /* -1 → 1 → -1 */
    return (a.amp ?? 0) * tri
  },
  /** 张望：平滑方波，在 ±amp 两端各停留片刻再换边（左看看、右看看） */
  glance: (a, t) => {
    const per = a.period || 3600
    const ph = TAU * (((t + (a.phaseMs || 0)) % per) / per) + (a.phase || 0)
    return (a.amp ?? 0) * Math.tanh(2.8 * Math.sin(ph))
  },
  /** 周期眨眼：interval 周期内前 dur 毫秒闭合再睁开（返回负值叠加到 open）
   *  相位叠加实例随机种子，多实例不会同步眨眼 */
  blink: (a, t, eng) => {
    const interval = a.interval || 3800,
      dur = a.dur || 200
    const p = (t + (a.phaseMs || 0) + (eng ? eng.seed * 97 : 0)) % interval
    if (p >= dur) return 0
    return -(a.depth == null ? 1 : a.depth) * Math.sin(Math.PI * (p / dur))
  },
}

/* 只作用在这三类姿态节点上：body / 单眼；'scale' 在眼睛上要同时改 scaleX 与 scaleY */
function animTargets(pose: Pose, a: AnimSpec, isBody: boolean): NumericPosePart[] {
  return a.target === 'eyes'
    ? [fieldsOf(pose.left), fieldsOf(pose.right)]
    : isBody
      ? [fieldsOf(pose.body)]
      : a.target === 'left'
        ? [fieldsOf(pose.left)]
        : a.target === 'right'
          ? [fieldsOf(pose.right)]
          : []
}

function applyAnimValue(tg: NumericPosePart, prop: AnimSpec['prop'], isBody: boolean, v: number): void {
  if (prop === 'scale') {
    if (isBody) tg.scale = num(tg.scale) + v
    else {
      tg.scaleX = num(tg.scaleX) + v
      tg.scaleY = num(tg.scaleY) + v
    }
  } else if (prop !== undefined) {
    tg[prop] = num(tg[prop]) + v
  }
}

function applyAnim(pose: Pose, a: AnimSpec, t: number, eng: Engine): void {
  const fn = ANIM_TYPES[a.type]
  if (!fn) return
  const v = fn(a, t, eng)
  const isBody = a.target === 'body'
  const targets = animTargets(pose, a, isBody)
  for (const tg of targets) {
    applyAnimValue(tg, a.prop, isBody, v)
  }
}

/* ---------------- 配置注册中心 ---------------- */

const GROUPS = EMOTION_GROUPS.slice()

const registry = new Map<string, EmotionDef>()
const order: string[] = []

function knownGroup(g: string | undefined): boolean {
  return GROUPS.some((x) => x.key === g)
}

function validate(raw: EmotionRaw): string[] {
  const errs: string[] = []
  if (!raw || typeof raw !== 'object') {
    errs.push('配置必须是对象')
    return errs
  }
  if (typeof raw.id !== 'string' || !raw.id.trim()) errs.push('缺少合法的字符串 id')
  if (typeof raw.name !== 'string' || !raw.name.trim()) errs.push('缺少 name')
  if (!knownGroup(raw.group)) errs.push(`group 不合法：${raw.group}`)
  if (raw.anims != null) {
    if (!Array.isArray(raw.anims)) errs.push('anims 必须是数组')
    else
      raw.anims.forEach((a: AnimSpec, i: number) => {
        if (!a || !ANIM_TYPES[a.type]) errs.push(`anims[${i}] 未知动画类型：${a?.type}`)
      })
  }
  if (raw.sequence != null && !Array.isArray(raw.sequence.frames)) {
    errs.push('sequence.frames 必须是数组')
  }
  return errs
}

/** 归一化：深合并默认姿态，预生成 sequence 每帧的完整 pose */
function normalize(raw: EmotionRaw): EmotionDef {
  const base = applySpec(defaultPose(), raw)
  let pool = (raw.pool ?? [0, 8]).filter((i: number) => i >= 0 && i < EXPR.length)
  if (!pool.length) pool = [0]
  const def: EmotionDef = {
    id: raw.id,
    name: raw.name,
    group: raw.group,
    desc: raw.desc ?? '',
    en: raw.en ?? null /* 可选英文文案 { name, desc } */,
    gaze: raw.gaze !== false,
    transition: raw.transition != null ? raw.transition : 500,
    /* 表情池系统：pool = 眼环索引池，poolMs 间隔内随机轮换；
     * blinkMs = 眨眼间隔（null 不眨）；openness = 常驻开合度；
     * antics = 待机随机小动作（自旋 / 弹跳） */
    pool: pool,
    poolMs: (raw.poolMs ?? [9000, 16000]) as [number, number],
    poolSpeed: raw.poolSpeed || 6,
    blinkMs: (raw.blinkMs !== undefined ? raw.blinkMs : [6000, 14000]) as [number, number] | null,
    openness: raw.openness != null ? raw.openness : 1,
    antics: !!raw.antics,
    base: base,
    anims: (raw.anims ?? []).map((a: AnimSpec) => ({ ...a })),
    sequence: null,
    raw: raw,
  }
  if (raw.sequence) {
    const frames = raw.sequence.frames
      .map((f: PoseSpec & { at?: number | undefined }) => ({ at: f.at || 0, pose: applySpec(clonePose(base), f) }))
      .sort((x: PoseFrame, y: PoseFrame) => x.at - y.at)
    def.sequence = { frames, settle: raw.sequence.settle || 'base' }
  }
  return def
}

function register(raw: EmotionRaw): { ok: boolean; id?: string | undefined; errors?: string[] | undefined } {
  const errs = validate(raw)
  if (errs.length) return { ok: false, id: raw.id, errors: errs }
  const def = normalize(raw)
  if (!registry.has(def.id)) order.push(def.id)
  registry.set(def.id, def)
  return { ok: true, id: def.id }
}

/* 种子装载阶段还没有实例，用静默出口兜底 */
const silentLogger: EngineLogger = { warn: () => {}, error: () => {} }

export const config = {
  register,
  get: (id: string): EmotionDef | null => registry.get(id) ?? null,
  list: (group?: string): EmotionDef[] => {
    return order.map((id) => registry.get(id)!).filter((d) => !group || d.group === group)
  },
  groups: () => GROUPS.map((g) => ({ key: g.key, name: g.name, en: g.en || g.name })),
  exportConfig: () =>
    JSON.stringify(
      order.map((id) => registry.get(id)!.raw),
      null,
      2,
    ),
  importConfig: (json: unknown): { ok: boolean; added: number; errors: string[] } => {
    let data: unknown
    try {
      data = typeof json === 'string' ? JSON.parse(json) : json
    } catch (cause) {
      return {
        ok: false,
        added: 0,
        errors: [`JSON 解析失败：${cause instanceof Error ? cause.message : String(cause)}`],
      }
    }
    const arr = Array.isArray(data) ? data : [data]
    let added = 0
    const errors: string[] = []
    arr.forEach((raw) => {
      const r = register(raw as EmotionRaw)
      if (r.ok) added++
      else errors.push(`[${(raw as EmotionRaw | null)?.id ?? '?'}] ${(r.errors ?? []).join('；')}`)
    })
    return { ok: errors.length === 0, added, errors }
  },
}

/* ---------------- 全局共享 rAF 时钟（多实例单循环） ---------------- */

const ticker = {
  set: new Set<Engine>(),
  raf: 0,
  add(e: Engine): void {
    this.set.add(e)
    if (!this.raf) this.raf = requestAnimationFrame(ticker.loop)
  },
  remove(e: Engine): void {
    this.set.delete(e)
  },
  loop(now: number): void {
    ticker.raf = 0
    ticker.set.forEach((e) => {
      e.tick(now)
    })
    if (ticker.set.size) ticker.raf = requestAnimationFrame(ticker.loop)
  },
}

/* ---------------- EmotionEngine ---------------- */

/** 解析容器：字符串走 querySelector；找不到容器是不变量错误（构造器原逻辑原样搬出） */
function resolveTargetEl(target: string | Element): Element {
  const el = typeof target === 'string' ? document.querySelector(target) : target
  if (!el) invariant(false, 'EmotionBall.create：找不到容器元素')
  return el
}

/** 转交 ball 的选项：lite 缺省时等价于「不自启」（构造器原逻辑原样搬出） */
function mergeBallOptions(opts: EngineOptions): EngineOptions {
  return Object.assign({}, opts, {
    lite: opts.lite != null ? opts.lite : opts.autostart === false,
  })
}

/** 实例主题色：只有给了体色才生效，眼睛默认白（构造器原逻辑原样搬出） */
function themeFromOpts(opts: EngineOptions): { body: string; eyes: string } | null {
  return opts.color ? { body: opts.color, eyes: opts.eyeColor || '#FFFFFF' } : null
}

/** 待机策略归一化：补默认时长 / ID（构造器原 if-else 原样搬出，求值时机不变） */
function idleFromOpts(opts: EngineOptions): IdlePolicy | null {
  if (opts.idle) {
    return Object.assign(
      { standbyAfter: 60000, sleepAfter: 180000, standbyId: '02', sleepId: '00' },
      opts.idle === true ? {} : opts.idle,
    )
  }
  return null
}

export class Engine {
  readonly ball: BallHandle
  private readonly _seed: number
  private _events: Record<string, ((payload: never) => void)[]>
  private readonly _gaze: { x: number; y: number; tx: number; ty: number }
  private readonly _style: { sketch: number }
  private readonly _theme: { body: string; eyes: string } | null
  private readonly _eyeScale: number
  private _lastTick: number
  private _spin: Spring | null
  private _ringSrc: [EyeRing, EyeRing]
  private _ringDst: [EyeRing, EyeRing]
  private _ringCur: [EyeRing, EyeRing]
  private readonly _ringSpring: Spring
  private _ringSpeed: number
  private _exprIdx: number
  private _poolPos: number
  private _poolNext: number
  private readonly _open: Spring
  private _blinkQ: BlinkKey[]
  private _blinkNext: number
  private _anticNext: number
  private _bounceAt: number
  private _def: EmotionDef | null
  private _lastPose: Pose | null
  private _prevPose: Pose | null
  private _transStart: number
  private _transDur: number
  private _emoStart: number
  private _seq: SequenceState | null
  private _active: boolean
  private _touring: boolean
  private _tourTimer: ReturnType<typeof setInterval> | 0
  private readonly _fallbackId: string
  private _lastActivity: number
  private _idle: IdlePolicy | null
  private _dt = 1 / 60
  private readonly _logger: EngineLogger

  /** jitter / blink 原语要拿实例种子做相位错开 */
  get seed(): number {
    return this._seed
  }

  constructor(target: string | Element, opts: EngineOptions = {}) {
    opts = opts || {}
    const el = resolveTargetEl(target)

    this.ball = createBall(el, mergeBallOptions(opts))
    this._seed = Math.random() * 100
    this._events = {}
    this._gaze = { x: 0, y: 0, tx: 0, ty: 0 }
    this._style = { sketch: 0 }
    this._theme = themeFromOpts(opts)
    this._eyeScale = opts.eyeScale || 1
    this._lastTick = 0
    this._spin = null /* { x, v, t }：弹簧驱动的整圈自旋（彩带触发源） */

    /* ---- 表情形变系统 ---- */
    this._ringSrc = [EXPR[0]![0], EXPR[0]![1]] /* 形变起点环对 */
    this._ringDst = [EXPR[0]![0], EXPR[0]![1]] /* 形变目标环对 */
    this._ringCur = this._ringDst /* 当前展示环对（引用比较驱动 d 更新） */
    this._ringSpring = spring(1) /* 形变进度 0→1 */
    this._ringSpeed = 7
    this._exprIdx = 0
    this._poolPos = 0
    this._poolNext = 0
    /* ---- 眨眼系统：开合度弹簧（频率 26）+ 关键帧队列 ---- */
    this._open = spring(1)
    this._blinkQ = []
    this._blinkNext = Infinity
    /* ---- 待机小动作 ---- */
    this._anticNext = 0
    this._bounceAt = -1

    this._def = null
    this._lastPose = null
    this._prevPose = null
    this._transStart = 0
    this._transDur = 0
    this._emoStart = 0
    this._seq = null
    this._active = false
    this._touring = false
    this._tourTimer = 0
    this._fallbackId = opts.fallbackId || FALLBACK_ID
    this._lastActivity = performance.now()

    this._idle = idleFromOpts(opts)

    this._logger = opts.logger ?? silentLogger
    this.setEmotion(opts.emotion || this._fallbackId, { auto: true })
    if (opts.autostart !== false) this.setActive(true)
    else this.renderStatic()
  }

  /* ---------- 事件 ---------- */
  on(evt: string, cb: (payload: never) => void): this {
    const list = this._events[evt] ?? []
    list.push(cb)
    this._events[evt] = list
    return this
  }
  off(evt: string, cb: (payload: never) => void): this {
    const list = this._events[evt]
    if (list) {
      const i = list.indexOf(cb)
      if (i >= 0) list.splice(i, 1)
    }
    return this
  }
  private _emit(evt: string, payload: unknown): void {
    for (const cb of (this._events[evt] ?? []).slice()) {
      try {
        cb(payload as never)
      } catch (cause) {
        this._logger.error(`[EmotionBall] 事件回调抛错：${evt}`, cause)
      }
    }
  }

  get emotionId() {
    return this._def ? this._def.id : null
  }
  get touring() {
    return this._touring
  }

  /** 查表 + 未知 ID 兜底：拿不到就返回 null（setEmotion 原分支原样搬出） */
  private _resolveDef(id: string): EmotionDef | null {
    const def = config.get(id)
    if (def) return def
    this._logger.warn(`[EmotionBall] 未知表情 ID "${id}"，回退到待机 (${this._fallbackId})`)
    this._emit('error', { message: `未知表情 ID "${id}"，已回退待机`, id: id })
    return config.get(this._fallbackId)
  }

  /** 切换时的姿态 / 过渡 / sequence 状态写入（顺序与上游一致） */
  private _beginTransition(def: EmotionDef, now: number, auto: boolean): void {
    this._prevPose = this._lastPose ? clonePose(this._lastPose) : null
    this._def = def
    this._emoStart = now
    this._transStart = now
    this._transDur = this._prevPose ? def.transition : 0
    this._seq = def.sequence ? { frames: def.sequence.frames, settle: def.sequence.settle, done: false } : null
    if (!auto) this._lastActivity = now
  }

  /** 状态切换：眼环弹到新池首个表情（兴奋类用更快弹簧），
   *  并且切换瞬间先眨一次眼（睡眠 / 停止类除外） */
  private _scheduleBlinkPool(def: EmotionDef, now: number, prevId: string | null): void {
    this._poolPos = 0
    this._setExpr(def.pool[0]!, def.poolSpeed >= 10 ? 10 : 8)
    this._poolNext = now + rand(def.poolMs[0], def.poolMs[1])
    if (prevId !== null && prevId !== def.id && def.blinkMs) this._blinkNow(now)
    this._blinkNext = def.blinkMs ? now + rand(def.blinkMs[0], def.blinkMs[1]) : Infinity
    this._anticNext = now + rand(2500, 5000)
  }

  /** 配置中的 ribbons / confetti 是进入表情时的一次性事件：
   *  ribbons → 自旋甩彩带；confetti → 撒花爆发 */
  private _entryFx(def: EmotionDef): void {
    const fx = def.base.body
    if (fx.ribbons > 0) this.spin(fx.ribbons >= 1 ? 2 : 1)
    if (fx.confetti > 0) this.burst(20)
  }

  /* ---------- 核心：切换表情（含兜底） ---------- */
  setEmotion(id: string, o: { auto?: boolean | undefined } = {}): boolean {
    const def = this._resolveDef(id)
    if (!def) return false
    const now = performance.now()
    const prevId = this._def ? this._def.id : null
    this._beginTransition(def, now, !!o.auto)
    this._scheduleBlinkPool(def, now, prevId)

    this._emit('change', { id: def.id, def: def, auto: !!o.auto })
    if (this._active) this._entryFx(def)
    if (!this._active) this.renderStatic()
    return true
  }

  /** AI 对接入口：接受对象或 JSON 字符串 { emotionId, tips } */
  handleAIMessage(msg: unknown): boolean {
    let obj: unknown = msg
    if (typeof msg === 'string') {
      try {
        obj = JSON.parse(msg)
      } catch {
        this._emit('error', { message: 'AI 消息 JSON 解析失败，已回退待机', raw: msg })
        this.setEmotion(this._fallbackId)
        return false
      }
    }
    if (obj === null || typeof obj !== 'object') {
      this._emit('error', { message: 'AI 消息缺少 emotionId 字段，已回退待机', raw: msg })
      this.setEmotion(this._fallbackId)
      return false
    }
    const message = obj as { emotionId?: unknown; tips?: unknown }
    if (typeof message.emotionId !== 'string') {
      this._emit('error', { message: 'AI 消息缺少 emotionId 字段，已回退待机', raw: msg })
      this.setEmotion(this._fallbackId)
      return false
    }
    const ok = this.setEmotion(message.emotionId)
    if (message.tips) this._emit('tips', { text: String(message.tips) })
    return ok
  }

  /* ---------- 自动巡演 ---------- */
  startTour(ids: readonly string[], interval?: number): void {
    this.stopTour()
    if (!ids?.length) return
    const gap = interval || 2500
    this._touring = true
    let i = 0
    this.setEmotion(ids[0]!, { auto: true })
    this._tourTimer = setInterval(() => {
      i = (i + 1) % ids.length
      this.setEmotion(ids[i]!, { auto: true })
    }, gap)
  }
  stopTour() {
    if (this._tourTimer) {
      clearInterval(this._tourTimer)
      this._tourTimer = 0
    }
    this._touring = false
    this._lastActivity = performance.now()
  }

  resetIdle() {
    this._lastActivity = performance.now()
  }

  /* 注视目标：横向 ±24、纵向 ±15（viewBox 坐标），幅度克制以保持含蓄 */
  setGaze(nx: number, ny: number): this {
    this._gaze.tx = clamp(nx, -1, 1) * 24
    this._gaze.ty = clamp(ny, -1, 1) * 15
    return this
  }
  clearGaze(): this {
    this._gaze.tx = 0
    this._gaze.ty = 0
    return this
  }
  setStyle(style?: { sketch?: number | undefined }): this {
    Object.assign(this._style, style ?? {})
    if (!this._active) this.renderStatic()
    return this
  }

  /* 自旋（点击交互）：弹簧追整数圈，达速后由渲染层甩出彩带；
   * 进行中的自旋不可打断，追加请求直接忽略 */
  spin(turns?: number, dir?: number): this {
    if (this._spin) return this
    const d = dir || (Math.random() < 0.5 ? -1 : 1)
    this._spin = { x: 0, v: 0, t: Math.max(1, Math.round(turns || 1)) * TAU * d }
    return this
  }
  /* 撒花：一次性物理粒子爆发 */
  burst(count?: number): this {
    this.ball.burst(count ?? 0)
    return this
  }
  /* 弹跳（4 段递减抛物线） */
  bounce(): this {
    if (this._bounceAt < 0) this._bounceAt = performance.now()
    return this
  }

  /* 切换眼环目标：把当前插值冻结为新起点，弹簧从 0 重新弹向 1 */
  private _setExpr(idx: number, speed?: number): void {
    if (idx === this._exprIdx && this._ringSpring.x >= 0.999) return
    const s = clamp(this._ringSpring.x, 0, 1)
    this._ringSrc = [lerpRing(this._ringSrc[0], this._ringDst[0], s), lerpRing(this._ringSrc[1], this._ringDst[1], s)]
    this._ringDst = [EXPR[idx]![0], EXPR[idx]![1]]
    this._ringSpring.x = 0
    this._ringSpring.v = 0
    this._ringSpring.t = 1
    this._ringSpeed = speed || 7
    this._exprIdx = idx
  }

  /* 眨眼关键帧：合上 → 停 70ms → 睁到 1.08 过冲 → 300ms 落回 1，
   * 14% 概率追加第二次连眨 */
  private _blinkNow(t: number): void {
    this._blinkQ.push({ at: t, v: 0.05 }, { at: t + 70, v: 0.05 }, { at: t + 150, v: 1.08 }, { at: t + 300, v: 1 })
    if (Math.random() < 0.14) {
      this._blinkQ.push({ at: t + 370, v: 0.05 }, { at: t + 480, v: 1 })
    }
  }

  registerEmotion(raw: EmotionRaw): { ok: boolean; id?: string | undefined; errors?: string[] | undefined } {
    return config.register(raw)
  }

  /* ---------- 生命周期 ---------- */
  setActive(on: boolean): void {
    if (on === this._active) return
    this._active = on
    if (on) ticker.add(this)
    else ticker.remove(this)
  }
  replay() {
    if (this._def) this.setEmotion(this._def.id, { auto: true })
  }
  /** 静态渲染一帧（缩略图用基础姿态，不播 sequence 第 0 帧；弹簧直接置终值） */
  renderStatic() {
    this._transDur = 0
    this._ringSpring.x = 1
    this._ringSpring.v = 0
    this._open.x = this._def ? this._def.openness : 1
    this._open.v = 0
    const seq = this._seq
    this._seq = null
    this.tick(performance.now())
    this._seq = seq
  }
  destroy() {
    this.stopTour()
    this.setActive(false)
    this._events = {}
    this.ball.destroy()
  }

  /* ---------- 每帧 ---------- */
  tick(now: number): void {
    this._dt = this._lastTick ? clamp((now - this._lastTick) / 1000, 0.001, 0.05) : 1 / 60
    this._lastTick = now
    if (this._idle && !this._touring) this._checkIdle(now)
    const pose = this._compose(now, 0)
    this.ball.applyPose(pose)
    this._lastPose = pose
  }

  private _checkIdle(now: number): void {
    const idle = this._idle
    if (!idle) return
    const elapsed = now - this._lastActivity
    const cur = this.emotionId
    if (elapsed >= idle.sleepAfter) {
      if (cur !== idle.sleepId) this.setEmotion(idle.sleepId, { auto: true })
    } else if (elapsed >= idle.standbyAfter) {
      if (cur !== idle.standbyId && cur !== idle.sleepId) {
        this.setEmotion(idle.standbyId, { auto: true })
      }
    }
  }

  /** 合成当前帧姿态：base → sequence → animators → 过渡插值 */
  private _compose(now: number, depth: number): Pose {
    const def = this._def
    if (!def) return defaultPose()
    const t = now - this._emoStart
    let pose: Pose

    if (this._seq) {
      const res = this._seqPose(t, now)
      if (res === 'switch') {
        /* sequence 播完且 settle.next：已切到新表情，重新合成 */
        return depth < 4 ? this._compose(now, depth + 1) : clonePose(this._def?.base ?? def.base)
      }
      pose = res ?? clonePose(def.base)
    } else {
      pose = clonePose(def.base)
    }

    this._applyAnims(pose, def, now, t)

    const dt = this._dt || 1 / 60

    this._advanceSchedules(now, def)

    this._stepSprings(dt)
    pose.body.yaw = this._spin ? this._spin.x : 0

    this._applyBounce(now, pose)

    this._composeRing(pose)
    this._composeGaze(pose, def, now, dt)
    this._finishEyes(pose)

    /* 表情切换过渡插值 */
    const tt = now - this._transStart
    if (this._transDur > 0 && tt < this._transDur && this._prevPose) {
      pose = lerpPose(this._prevPose, pose, easeInOutCubic(tt / this._transDur))
    }
    return pose
  }

  /** 内置呼吸 + 动画原语：相位用绝对时间，切换表情不跳变 */
  private _applyAnims(pose: Pose, def: EmotionDef, now: number, t: number): void {
    const br = pose.body.breathe || 0
    if (br) {
      const ph = (TAU * now) / 3600
      pose.body.scale += br * Math.sin(ph)
      pose.body.y += br * 55 * Math.sin(ph + 0.6)
    }

    for (const anim of def.anims) applyAnim(pose, anim, t, this)

    pose.body.sketch = Math.max(pose.body.sketch || 0, this._style.sketch || 0)
  }

  /** 当前眼环：形变中逐点插值，静止后复用目标引用（跳过 d 重建） */
  private _composeRing(pose: Pose): void {
    if (this._ringSpring.x < 0.999 || this._ringSpring.v > 0.001 || this._ringSpring.v < -0.001) {
      const rs = clamp(this._ringSpring.x, 0, 1.35)
      this._ringCur = [
        lerpRing(this._ringSrc[0], this._ringDst[0], rs),
        lerpRing(this._ringSrc[1], this._ringDst[1], rs),
      ]
    } else if (this._ringCur !== this._ringDst) {
      this._ringCur = this._ringDst
    }
    pose.left.ring = this._ringCur[0]
    pose.right.ring = this._ringCur[1]
  }

  /** 注视：鼠标目标指数平滑（帧率无关）+ 常驻眼神微漂移（每只眼相位错开） */
  private _composeGaze(pose: Pose, def: EmotionDef, now: number, dt: number): void {
    const k = 1 - Math.exp(-5.66 * dt)
    const gx = def.gaze !== false ? this._gaze.tx : 0
    const gy = def.gaze !== false ? this._gaze.ty : 0
    this._gaze.x += (gx - this._gaze.x) * k
    this._gaze.y += (gy - this._gaze.y) * k
    pose.left.lookX += this._gaze.x
    pose.right.lookX += this._gaze.x
    pose.left.lookY += this._gaze.y
    pose.right.lookY += this._gaze.y

    if (def.gaze !== false) {
      const w = now / 1000
      pose.left.lookX += 1.4 * Math.sin(0.42 * w) + 0.5 * Math.sin(1.0 * w)
      pose.right.lookX += 1.4 * Math.sin(0.42 * w + 1) + 0.5 * Math.sin(1.0 * w + 2)
      pose.left.lookY += 0.9 * Math.sin(0.58 * w)
      pose.right.lookY += 0.9 * Math.sin(0.58 * w + 1)
    }
  }

  /** 眼睛收尾：小尺寸放大占比、实例主题色、开合度与最小缩放钳位 */
  private _finishEyes(pose: Pose): void {
    if (this._eyeScale !== 1) {
      pose.left.scaleX *= this._eyeScale
      pose.left.scaleY *= this._eyeScale
      pose.right.scaleX *= this._eyeScale
      pose.right.scaleY *= this._eyeScale
    }

    if (this._theme) {
      pose.body.color = this._theme.body
      if (pose.left.color === DEFAULT_EYE.color) pose.left.color = this._theme.eyes
      if (pose.right.color === DEFAULT_EYE.color) pose.right.color = this._theme.eyes
    }

    /* 开合度 = 配置基础值 × 眨眼弹簧（弹簧可过冲到 1.08） */
    const openS = clamp(this._open.x, 0.02, 1.5)
    pose.left.open = clamp(pose.left.open, 0, 1.3) * openS
    pose.right.open = clamp(pose.right.open, 0, 1.3) * openS
    pose.left.scaleX = Math.max(pose.left.scaleX, 0.05)
    pose.left.scaleY = Math.max(pose.left.scaleY, 0.05)
    pose.right.scaleX = Math.max(pose.right.scaleX, 0.05)
    pose.right.scaleY = Math.max(pose.right.scaleY, 0.05)
  }

  /** 表情池轮换 / 眨眼调度 / 待机小动作：三者都按各自的 next 时刻推进入队 */
  private _advanceSchedules(now: number, def: EmotionDef): void {
    /* ---- 表情池轮换：poolMs 间隔内随机跳到池内另一个眼环 ---- */
    if (this._active && now >= this._poolNext) {
      if (def.pool.length > 1) {
        this._poolPos = (this._poolPos + 1 + Math.floor(rand(0, def.pool.length - 1))) % def.pool.length
        this._setExpr(def.pool[this._poolPos]!, def.poolSpeed)
      }
      this._poolNext = now + rand(def.poolMs[0], def.poolMs[1])
    }

    /* ---- 眨眼调度：间隔到点入队关键帧，队列驱动开合度弹簧目标 ---- */
    if (this._active && def.blinkMs && now >= this._blinkNext) {
      this._blinkNow(now)
      this._blinkNext = now + rand(def.blinkMs[0], def.blinkMs[1])
    }
    let openKey: number | null = null
    while (this._blinkQ.length && now >= this._blinkQ[0]!.at) {
      openKey = this._blinkQ[0]!.v
      this._blinkQ.shift()
    }
    this._open.t = openKey !== null ? openKey : this._blinkQ.length ? this._open.t : def.openness

    /* ---- 待机小动作：9~18s 随机自旋 / 弹跳 ---- */
    if (this._active && def.antics && now >= this._anticNext) {
      if (!this._spin && this._bounceAt < 0) {
        const pick = Math.random()
        if (pick < 0.45) this.spin(1)
        else if (pick < 0.8) this.bounce()
        else this._blinkNow(now)
      }
      this._anticNext = now + rand(9000, 18000)
    }
  }

  /** 弹簧整步（子步 1/120 保稳定）：形变 / 开合 / 自旋 */
  private _stepSprings(dt: number): void {
    /* ---- 弹簧整步（子步 1/120 保稳定）：形变 / 开合 / 自旋 ---- */
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
    const j = dt / steps
    for (let si = 0; si < steps; si++) {
      springStep(this._ringSpring, this._ringSpeed, 1, j)
      springStep(this._open, 26, 1, j)
      if (this._spin) {
        springStep(this._spin, 6.2, 1, j)
        if (Math.abs(this._spin.t - this._spin.x) < 0.01 && Math.abs(this._spin.v) < 0.05) {
          this._spin = null
        }
      }
    }
  }

  /** 弹跳位移：-4·h·n(1-n) 抛物线 */
  private _applyBounce(now: number, pose: Pose): void {
    /* ---- 弹跳位移：-4·h·n(1-n) 抛物线 ---- */
    if (this._bounceAt >= 0) {
      const be = (now - this._bounceAt) / 1000
      if (be >= BOUNCE_TOTAL) {
        this._bounceAt = -1
      } else {
        let acc = 0,
          bi = 0
        while (bi < BOUNCE_SEGS.length && be >= acc + BOUNCE_SEGS[bi]!.d) {
          acc += BOUNCE_SEGS[bi]!.d
          bi++
        }
        const seg = BOUNCE_SEGS[Math.min(bi, BOUNCE_SEGS.length - 1)]!
        const bn = (be - acc) / seg.d
        pose.body.y += -4 * seg.h * bn * (1 - bn)
      }
    }
  }

  /** sequence 采样；播完按 settle 处理（hold / base / next） */
  private _seqPose(t: number, now: number): Pose | 'switch' | null {
    const seq = this._seq
    if (!seq || seq.frames.length === 0) return null
    const frames = seq.frames
    const last = frames[frames.length - 1]!

    if (t >= last.at) {
      if (!seq.done) {
        seq.done = true
        const s = seq.settle
        if (s === 'base') {
          /* 从序列末帧平滑回落到基础姿态 */
          this._prevPose = this._lastPose ? clonePose(this._lastPose) : clonePose(last.pose)
          this._transStart = now
          this._transDur = this._def?.transition || 500
          this._seq = null
          return null
        }
        if (typeof s === 'object' && s.next) {
          this.setEmotion(s.next, { auto: true })
          return 'switch'
        }
        /* settle === 'hold'：定格在末帧 */
      }
      return clonePose(last.pose)
    }

    const first = frames[0]!
    if (t <= first.at) return clonePose(first.pose)
    for (let i = 0; i < frames.length - 1; i++) {
      const a = frames[i]!,
        b = frames[i + 1]!
      if (t >= a.at && t < b.at) {
        const k = easeInOutCubic((t - a.at) / (b.at - a.at))
        return lerpPose(a.pose, b.pose, k)
      }
    }
    return clonePose(last.pose)
  }
}

/* ---------------- 对外入口 ---------------- */

/** 建一个有自己 rAF 生命周期的实例；destroy() 必须被调用，否则实例留在 ticker 里 */
export function createEngine(target: string | Element, opts?: EngineOptions): EngineHandle {
  return new Engine(target, opts)
}
export const ENGINE_VERSION = '1.0.0'

/* 载入种子配置（数据层已随模块打进包，不再依赖脚本加载顺序） */
for (const raw of EMOTION_SEED) {
  const result = register(raw)
  if (!result.ok) silentLogger.warn(`[EmotionBall] 种子配置无效：${result.id} ${(result.errors ?? []).join('；')}`)
}
