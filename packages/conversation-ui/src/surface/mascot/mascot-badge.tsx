import './mascot.css'
import { createPreference } from '@poietica/external-store'
import { warn } from '@poietica/problem'
import { memo, useEffect, useId, useRef, useState } from 'react'
import { mountMascot } from './engine'
import { BODY_D } from './expressions'

/*
 * 欢迎页的吉祥物：一块与正文同一条渲染管线的内联 SVG。
 *
 * 本组件只做三件事：渲染骨架、把偏好与整窗指针交给引擎句柄、卸载时收拾
 * 干净。动画状态的唯一真相在 engine.ts 的闭包里，这里不持有任何逐帧状态；
 * 上色全在 mascot.css，换主题不经过 JS。
 *
 * 开关（自动巡演 / 跟随指针）统一读 @poietica/design-system 的 createPreference。
 * 同窗口的改动由设置面板的窗口事件送达，其他窗口的改动由 Preference 经
 * storage 事件送达 —— 两条路都直接落到引擎句柄。本组件只读不写：
 * 偏好的唯一写入者是设置面板。
 */

const PREF_TOUR = 'poietica.mascot.autoTour'
const PREF_FOLLOW = 'poietica.mascot.followPointer'
const PREFS_EVENT = 'poietica:mascot-prefs'

const FAILURE_MESSAGES = {
  read: '读不出吉祥物偏好，使用默认值',
  write: '写不进吉祥物偏好，下次启动使用默认值',
}

function booleanPreference(key: string) {
  return createPreference<boolean>({
    key,
    fallback: true,
    decode: (raw) => raw !== '0',
    encode: (value) => (value ? '1' : '0'),
    onFailure: ({ stage, cause }) => {
      warn(FAILURE_MESSAGES[stage], { scope: 'mascot-preferences', cause })
    },
  })
}

export interface MascotBadgeProps {
  readonly className?: string | undefined
}

export const MascotBadge = memo(function MascotBadge({ className }: MascotBadgeProps) {
  const root = useRef<SVGSVGElement | null>(null)
  const clipId = useId()

  /* 每次挂载重新读取：设置页可能在吉祥物卸载期间改过值。 */
  const [tourPreference] = useState(() => booleanPreference(PREF_TOUR))
  const [followPreference] = useState(() => booleanPreference(PREF_FOLLOW))

  useEffect(() => {
    const svg = root.current

    if (svg === null) {
      return
    }

    const handle = mountMascot(svg, {
      tour: tourPreference.read(),
      follow: followPreference.read(),
    })

    /* 其他窗口的改动：Preference 经 storage 事件重读后通知。 */
    const forwardPreferences = () => {
      handle.setTour(tourPreference.read())
      handle.setFollow(followPreference.read())
    }

    /* 同窗口设置面板的改动：事件里带着布尔快照，直接交给引擎。 */
    const adoptPreferences = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail

      if (
        typeof detail !== 'object' ||
        detail === null ||
        !('tour' in detail) ||
        !('follow' in detail) ||
        typeof detail.tour !== 'boolean' ||
        typeof detail.follow !== 'boolean'
      ) {
        return
      }

      handle.setTour(detail.tour)
      handle.setFollow(detail.follow)
    }

    const stopTour = tourPreference.subscribe(forwardPreferences)
    const stopFollow = followPreference.subscribe(forwardPreferences)

    window.addEventListener(PREFS_EVENT, adoptPreferences)

    /* 整窗指针，rAF 合并成一帧至多一条，取最新坐标。 */
    let pending = 0
    let lastX = 0
    let lastY = 0

    const forwardPointer = (event: PointerEvent) => {
      lastX = event.clientX
      lastY = event.clientY

      if (pending !== 0) {
        return
      }

      pending = window.requestAnimationFrame(() => {
        pending = 0
        handle.pointerMoved(lastX, lastY)
      })
    }

    window.addEventListener('pointermove', forwardPointer, { passive: true })

    return () => {
      window.removeEventListener('pointermove', forwardPointer)

      if (pending !== 0) {
        window.cancelAnimationFrame(pending)
      }

      window.removeEventListener(PREFS_EVENT, adoptPreferences)
      stopFollow()
      stopTour()
      handle.dispose()
    }
  }, [followPreference, tourPreference])

  return (
    <svg
      aria-label="Poietica 吉祥物"
      className={className}
      data-mascot
      ref={root}
      role="img"
      viewBox="-46 -50 320.541 330"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={BODY_D} />
        </clipPath>
      </defs>
      <ellipse cx="114.27" cy="256" data-part="shadow" opacity="0.16" rx="74" ry="10" />
      <g data-part="fx-back" />
      <g data-part="rig">
        <path d={BODY_D} data-part="body" />
        <g clipPath={`url(#${clipId})`}>
          <g data-part="blush" opacity="0">
            <ellipse rx="13" ry="7" />
            <ellipse rx="13" ry="7" />
          </g>
          <path data-part="eye" />
          <path data-part="eye" />
        </g>
      </g>
      <g data-part="fx-front" />
    </svg>
  )
})
