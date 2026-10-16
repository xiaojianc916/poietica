/* 层间共享类型：pose 形状由 engine 合成、ball 消费，
 * 是两层之间唯一的契约，因此单独成文件。 */

import type { AnimProp, AnimSpec, EmotionRaw, PoseSpec, SequenceSpec } from './emotions'
import type { EyeRing, RingPoint, ShapeKey } from './rings'

/** 身体姿态：engine 每帧算出的值，ball 直接消费 */
export interface BodyPose {
  x: number
  y: number
  scale: number
  rotate: number
  color: string
  breathe: number
  ribbons: number
  confetti: number
  sketch: number
  zzz: number
  orbit: number
  /** 自旋偏航（rad），绕到背面时眼睛自动隐藏 */
  yaw: number
}

/** 单眼姿态 */
export interface EyePose {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotate: number
  open: number
  color: string
  lookX: number
  lookY: number
  /** 插值后的眼环；engine 引用不变时 ball 跳过 path 重建 */
  ring?: EyeRing | undefined
}

/** 一帧完整姿态 */
export interface Pose {
  body: BodyPose
  left: EyePose
  right: EyePose
}

/** 弹簧状态（临界阻尼步进用） */
export interface Spring {
  x: number
  v: number
  t: number
}

/** createBall 的选项（engine 会把 create 的选项并进来） */
export interface BallOptions {
  shape?: ShapeKey | undefined
  lite?: boolean | undefined
  color?: string | undefined
  eyeColor?: string | undefined
  /** engine 内部透传，ball 不消费；保留是为了不改上游调用形状 */
  [extra: string]: unknown
}

/** ball 句柄：engine 只用到这四个方法 */
export interface BallHandle {
  readonly svg: SVGSVGElement
  applyPose: (pose: Pose) => void
  burst: (count: number) => void
  destroy: () => void
}

/** 单个眼睛的 DOM 与缓存状态 */
export interface EyeNode {
  node: SVGPathElement
  ring: EyeRing
  c: RingPoint
  lastFill: string | null
  lastStroke: string | null
}

/** 实例的容错日志出口：app 侧不注入就等于全部静默（吉祥物是装饰件，坏了不打扰用户） */
export interface EngineLogger {
  warn: (message: string, ...rest: readonly unknown[]) => void
  error: (message: string, ...rest: readonly unknown[]) => void
}

/** 待机策略（idle 选项归一化后的形状） */
export interface IdlePolicy {
  standbyAfter: number
  sleepAfter: number
  standbyId: string
  sleepId: string
}

/** createEngine 的选项；只列 app 侧真的会传的字段，其余透传 */
export interface EngineOptions {
  emotion?: string | undefined
  autostart?: boolean | undefined
  idle?: boolean | IdlePolicy | undefined
  lite?: boolean | undefined
  color?: string | undefined
  eyeColor?: string | undefined
  eyeScale?: number | undefined
  fallbackId?: string | undefined
  shape?: ShapeKey | undefined
  /** 缺省时全部静默，避免装饰件往产品日志里刷噪声 */
  logger?: EngineLogger | undefined
  [extra: string]: unknown
}

/** 引擎对外能力：与 src/ui/home/mascot 的运行时接口一致 */
export interface EngineHandle {
  readonly emotionId: string | null
  readonly touring: boolean
  setEmotion: (id: string, o?: { auto?: boolean | undefined } | undefined) => boolean
  handleAIMessage: (msg: unknown) => boolean
  startTour: (ids: readonly string[], interval?: number | undefined) => void
  stopTour: () => void
  resetIdle: () => void
  setGaze: (nx: number, ny: number) => EngineHandle
  clearGaze: () => EngineHandle
  setStyle: (style: Partial<{ sketch: number }> | undefined) => EngineHandle
  spin: (turns?: number | undefined, dir?: number | undefined) => EngineHandle
  burst: (count?: number | undefined) => EngineHandle
  bounce: () => EngineHandle
  setActive: (on: boolean) => void
  replay: () => void
  renderStatic: () => void
  on: (evt: string, cb: (payload: never) => void) => EngineHandle
  off: (evt: string, cb: (payload: never) => void) => EngineHandle
  registerEmotion: (raw: EmotionRaw) => { ok: boolean; id?: string | undefined; errors?: readonly string[] | undefined }
  destroy: () => void
}

/** sequence 的一帧：at 毫秒 + 预生成的完整姿态 */
export interface PoseFrame {
  at: number
  pose: Pose
}

/** 归一化后的 sequence 定义 */
export interface SequenceDef {
  frames: PoseFrame[]
  settle: 'base' | 'hold' | { next: string }
}

/** 运行中的 sequence 状态（比定义多一个 done 标记） */
export interface SequenceState {
  frames: PoseFrame[]
  settle: 'base' | 'hold' | { next: string }
  done: boolean
}

/** 归一化后的表情定义：validate + normalize 的产物，registry 存的就是它 */
export interface EmotionDef {
  id: string
  name: string
  group: string
  desc: string
  en: { name: string; desc: string } | null
  gaze: boolean
  transition: number
  pool: number[]
  poolMs: [number, number]
  poolSpeed: number
  blinkMs: [number, number] | null
  openness: number
  antics: boolean
  base: Pose
  anims: AnimSpec[]
  sequence: SequenceDef | null
  raw: EmotionRaw
}

/** 眨眼关键帧队列里的一项 */
export interface BlinkKey {
  at: number
  v: number
}

export type { AnimProp, AnimSpec, EmotionRaw, PoseSpec, SequenceSpec }

/** 姿态字段的动态视图：数值字段参与插值，color 走颜色插值，其余（ring 这类对象引用）原样直通。
 *  与 BodyPose / EyePose 是同一份对象的两种看法，不参与两个接口的静态形状。 */
export type NumericPosePart = Record<string, number | string | undefined>
