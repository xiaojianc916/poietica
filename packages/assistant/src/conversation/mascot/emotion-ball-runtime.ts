import '../../../vendor/aora-bot/emotion-ball/js/rings.js'
import '../../../vendor/aora-bot/emotion-ball/js/emotions.js'
import '../../../vendor/aora-bot/emotion-ball/js/ball.js'
import '../../../vendor/aora-bot/emotion-ball/js/engine.js'

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

declare global {
  interface Window {
    EmotionBall?: EmotionBallRuntime
  }
}

export function emotionBallRuntime(): EmotionBallRuntime {
  const runtime = window.EmotionBall
  if (runtime === undefined) {
    throw new Error('Aora Emotion Ball runtime did not initialize')
  }
  return runtime
}
