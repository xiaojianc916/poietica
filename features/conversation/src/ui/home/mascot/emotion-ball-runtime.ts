/* 吉祥物运行时入口：把 engine-runtime 里的引擎包成本功能的窄接口。
 *
 * 上游原始实现是 IIFE + window 全局（靠副作用 import 挂载），迁移后是普通 ES 模块；
 * 这里不读 window，也不再需要模块声明桩。
 * 接口只暴露 emotion-ball.tsx 真正用到的能力，引擎的完整能力不外泄。 */
import { invariant } from '@poietica/foundation'

import { config, createEngine } from './engine-runtime/engine'
import type { EngineHandle } from './engine-runtime/types'

export type EmotionGroup = 'life' | 'emotion' | 'agent' | 'custom'

export interface EmotionDefinition {
  readonly id: string
}

export interface EmotionBallEngine {
  readonly setEmotion: (id: string) => boolean
  readonly startTour: (ids: string[], interval: number) => void
  readonly stopTour: () => void
  readonly setActive: (active: boolean) => void
  readonly setGaze: (x: number, y: number) => EmotionBallEngine
  readonly clearGaze: () => EmotionBallEngine
  readonly spin: (turns: number) => EmotionBallEngine
  readonly destroy: () => void
}

export interface EmotionBallRuntime {
  readonly config: {
    readonly list: (group?: EmotionGroup) => readonly EmotionDefinition[]
  }
  readonly create: (
    target: HTMLElement,
    options: {
      readonly autostart: boolean
      readonly color: string
      readonly emotion: string
      readonly eyeColor: string
      readonly eyeScale: number
      readonly idle: false
      readonly label: string
      readonly shape: 'blob'
    },
  ) => EmotionBallEngine
}

/** 引擎实例比这里承诺的宽：收窄成组件要用的那几个方法，避免组件依赖内部细节。
 *  链式方法必须返回同一个窄接口对象（原实现返回 self），所以先建对象再回指。 */
function narrow(engine: EngineHandle): EmotionBallEngine {
  const handle: EmotionBallEngine = {
    setEmotion: (id) => engine.setEmotion(id),
    startTour: (ids, interval) => {
      engine.startTour(ids, interval)
    },
    stopTour: () => {
      engine.stopTour()
    },
    setActive: (active) => {
      engine.setActive(active)
    },
    setGaze: (x, y) => {
      engine.setGaze(x, y)
      return handle
    },
    clearGaze: () => {
      engine.clearGaze()
      return handle
    },
    spin: (turns) => {
      engine.spin(turns)
      return handle
    },
    destroy: () => {
      engine.destroy()
    },
  }
  return handle
}

export function emotionBallRuntime(): EmotionBallRuntime {
  return {
    config: {
      list: (group) => config.list(group),
    },
    create: (target, options) => {
      const engine = createEngine(target, options)
      invariant(engine !== null, 'Aora Emotion Ball 引擎创建失败')
      return narrow(engine)
    },
  }
}
