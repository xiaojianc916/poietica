import './emotion-ball.css'

import { memo, useCallback, useEffect, useRef } from 'react'

export type EmotionId =
  | '00'
  | '01'
  | '02'
  | '03'
  | '04'
  | '05'
  | '06'
  | '07'
  | '10'
  | '11'
  | '12'
  | '13'
  | '14'
  | '15'
  | '16'
  | '17'
  | '18'
  | '19'
  | '20'
  | '21'
  | '30'
  | '31'
  | '32'
  | '33'
  | '34'
  | '35'
  | '36'
  | '37'
  | '38'
  | '39'
  | '40'
  | '41'

export const ENTRY_EMOTION_IDS = [
  '00',
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
  '21',
] as const satisfies readonly EmotionId[]

interface EmotionBallEngine {
  readonly setEmotion: (id: string) => boolean
  readonly startTour: (ids: string[], interval: number) => void
  readonly stopTour: () => void
  readonly setActive: (active: boolean) => void
  readonly setGaze: (x: number, y: number) => EmotionBallEngine
  readonly clearGaze: () => EmotionBallEngine
  readonly spin: (turns: number) => EmotionBallEngine
  readonly destroy: () => void
}

interface EmotionBallRuntime {
  readonly create: (
    target: HTMLElement,
    options: {
      readonly autostart: boolean
      readonly color: string
      readonly emotion: string
      readonly eyeColor: string
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

const TOUR_INTERVAL_MS = 3200
const HEX_BODY_FALLBACK = '#2783de'
const HEX_EYE_FALLBACK = '#ffffff'

async function loadRuntime(): Promise<EmotionBallRuntime> {
  await import('./emotion-ball-runtime')

  const runtime = window.EmotionBall
  if (runtime === undefined) {
    throw new Error('Aora Emotion Ball runtime did not initialize')
  }

  return runtime
}

function bindTheme(target: HTMLElement): void {
  const bodyStops = target.querySelectorAll('radialGradient > stop')
  const bodyParts = target.querySelectorAll('svg > g:nth-of-type(2) > path')

  if (bodyStops.length !== 3 || bodyParts.length !== 3) {
    throw new Error('Aora Emotion Ball DOM contract changed')
  }

  bodyStops.item(0).classList.add('emotion-ball__body-highlight')
  bodyStops.item(1).classList.add('emotion-ball__body-base')
  bodyStops.item(2).classList.add('emotion-ball__body-shade')
  bodyParts.item(1).classList.add('emotion-ball__eye')
  bodyParts.item(2).classList.add('emotion-ball__eye')

  const svg = target.querySelector('svg')
  if (svg === null) {
    throw new Error('Aora Emotion Ball did not create an SVG')
  }

  svg.setAttribute('aria-hidden', 'true')
  svg.removeAttribute('role')
}

function surfaceFailure(cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  queueMicrotask(() => {
    throw error
  })
}

export interface EmotionBallProps {
  readonly className?: string | undefined
  readonly emotion: EmotionId
  readonly label: string
  readonly placement: 'agent' | 'entry'
  readonly tour?: readonly EmotionId[] | undefined
}

export const EmotionBall = memo(function EmotionBall({
  className,
  emotion,
  label,
  placement,
  tour,
}: EmotionBallProps) {
  const mount = useRef<HTMLElement | null>(null)
  const engine = useRef<EmotionBallEngine | null>(null)
  const currentEmotion = useRef(emotion)
  currentEmotion.current = emotion

  const attach = useCallback((node: HTMLElement | null) => {
    mount.current = node
  }, [])

  useEffect(() => {
    const target = mount.current
    if (target === null) {
      return undefined
    }

    let disposed = false
    let stop: (() => void) | undefined

    const start = async () => {
      const runtime = await loadRuntime()
      if (disposed) {
        return
      }

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
      const created = runtime.create(target, {
        autostart: !reducedMotion.matches,
        color: HEX_BODY_FALLBACK,
        emotion: currentEmotion.current,
        eyeColor: HEX_EYE_FALLBACK,
        idle: false,
        label: 'Aora Emotion Ball',
        shape: 'blob',
      })
      engine.current = created

      try {
        bindTheme(target)
      } catch (cause) {
        engine.current = null
        created.destroy()
        target.replaceChildren()
        throw cause
      }

      const syncMotion = () => {
        if (reducedMotion.matches) {
          created.stopTour()
          created.setActive(false)
          created.setEmotion(currentEmotion.current)
          return
        }

        created.setActive(true)
        if (tour !== undefined && tour.length > 0) {
          created.startTour([...tour], TOUR_INTERVAL_MS)
        }
      }

      let pendingFrame = 0
      let pointerX = 0
      let pointerY = 0

      const point = (event: PointerEvent) => {
        pointerX = event.clientX
        pointerY = event.clientY

        if (pendingFrame !== 0) {
          return
        }

        pendingFrame = window.requestAnimationFrame(() => {
          pendingFrame = 0
          const box = target.getBoundingClientRect()
          if (box.width === 0 || box.height === 0) {
            return
          }

          created.setGaze(
            (pointerX - (box.left + box.width / 2)) / (box.width / 2),
            (pointerY - (box.top + box.height / 2)) / (box.height / 2),
          )
        })
      }

      const clearGaze = () => {
        created.clearGaze()
      }

      reducedMotion.addEventListener('change', syncMotion)
      window.addEventListener('blur', clearGaze)
      window.addEventListener('pointermove', point, { passive: true })
      syncMotion()

      stop = () => {
        reducedMotion.removeEventListener('change', syncMotion)
        window.removeEventListener('blur', clearGaze)
        window.removeEventListener('pointermove', point)
        if (pendingFrame !== 0) {
          window.cancelAnimationFrame(pendingFrame)
        }
        if (engine.current === created) {
          engine.current = null
        }
        created.destroy()
        target.replaceChildren()
      }
    }

    void start().catch((cause: unknown) => {
      if (!disposed) {
        surfaceFailure(cause)
      }
    })

    return () => {
      disposed = true
      stop?.()
    }
  }, [tour])

  useEffect(() => {
    if (tour === undefined) {
      engine.current?.setEmotion(emotion)
    }
  }, [emotion, tour])

  const classes =
    className === undefined
      ? `emotion-ball emotion-ball--${placement}`
      : `emotion-ball emotion-ball--${placement} ${className}`

  if (placement === 'entry') {
    return (
      <button
        aria-label={label}
        className={classes}
        data-emotion={emotion}
        onClick={() => engine.current?.spin(1)}
        ref={attach}
        type="button"
      />
    )
  }

  return (
    <div aria-label={label} className={classes} data-emotion={emotion} ref={attach} role="img" />
  )
})
