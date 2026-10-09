import { InvariantError, invariant, lastResort } from '@poietica/foundation'
import './emotion-ball.css'

import { memo, useCallback, useEffect, useRef } from 'react'
import type { EmotionBallEngine, EmotionGroup } from './emotion-ball-runtime'

/*
 * 迁移说明：legacy 用 @poietica/problem 的 error() 把吉祥物运行时的问题喂给错误上报管线。
 * 新架构里那一层是内核日志（ctx.logger）与 toasts；组件拿不到内核句柄，吉祥物坏了也不该
 * 挡住对话，所以走日志系统不可用时的最后通道（lastResort）。
 */
function reportMascotError(...args: readonly unknown[]): void {
  lastResort('[emotion-ball]', args.map((a) => String(a)).join(' '))
}

export const ENTRY_EMOTION_GROUPS = ['life', 'emotion'] as const satisfies readonly EmotionGroup[]

const TOUR_INTERVAL_MS = 3200
const HEX_BODY_FALLBACK = '#2783de'
const HEX_EYE_FALLBACK = '#ffffff'

function bindTheme(target: HTMLElement): void {
  const bodyStops = target.querySelectorAll('radialGradient > stop')
  const bodyParts = target.querySelectorAll('svg > g:nth-of-type(2) > path')

  if (bodyStops.length !== 3 || bodyParts.length !== 3) {
    invariant(false, 'Aora Emotion Ball DOM contract changed')
  }

  bodyStops.item(0).classList.add('emotion-ball__body-highlight')
  bodyStops.item(1).classList.add('emotion-ball__body-base')
  bodyStops.item(2).classList.add('emotion-ball__body-shade')
  bodyParts.item(1).classList.add('emotion-ball__eye')
  bodyParts.item(2).classList.add('emotion-ball__eye')

  const svg = target.querySelector('svg')
  if (svg === null) {
    invariant(false, 'Aora Emotion Ball did not create an SVG')
  }

  svg.setAttribute('aria-hidden', 'true')
  svg.removeAttribute('role')
}

function reportRuntimeFailure(cause: unknown): void {
  /* 只是取一句话往上报：非 Error 的 cause 用 InvariantError 包一下，不新增异常类别。 */
  const failure = cause instanceof Error ? cause : new InvariantError(String(cause))
  reportMascotError('Aora Emotion Ball failed', {
    scope: 'assistant.mascot',
    reason: failure.message,
  })
}

export interface EmotionBallProps {
  readonly className?: string | undefined
  readonly emotion: string
  readonly label: string
  readonly placement: 'agent' | 'entry'
  readonly tour?: readonly EmotionGroup[] | undefined
}

export const EmotionBall = memo(function EmotionBall({ className, emotion, label, placement, tour }: EmotionBallProps) {
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
      const { emotionBallRuntime } = await import('./emotion-ball-runtime')
      const runtime = emotionBallRuntime()
      if (disposed) {
        return
      }

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
      const tourIds =
        tour === undefined ? undefined : tour.flatMap((group) => runtime.config.list(group).map(({ id }) => id))
      if (tourIds !== undefined && tourIds.length === 0) {
        invariant(false, 'Aora Emotion Ball tour groups produced no emotions')
      }

      const created = runtime.create(target, {
        autostart: !reducedMotion.matches,
        color: HEX_BODY_FALLBACK,
        emotion: currentEmotion.current,
        eyeColor: HEX_EYE_FALLBACK,
        eyeScale: placement === 'agent' ? 1.5 : 1,
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
        if (tourIds !== undefined) {
          created.startTour(tourIds, TOUR_INTERVAL_MS)
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
        target.replaceChildren()
        reportRuntimeFailure(cause)
      }
    })

    return () => {
      disposed = true
      stop?.()
    }
  }, [placement, tour])

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

  return <div aria-label={label} className={classes} data-emotion={emotion} ref={attach} role="img" />
})
