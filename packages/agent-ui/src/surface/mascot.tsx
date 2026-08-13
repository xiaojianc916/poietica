import { createPreference, warn } from '@poietica/core'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

/*
 * 欢迎页的吉祥物。
 *
 * 本体是 apps/desktop/public/mascot.html —— 根目录 index.html 的嵌入版，由
 * 仓库根的 refactor.mjs 生成，整套 SVG 动画引擎自成一页，这里用同源 iframe
 * 承载：纯矢量渲染，任何尺寸与 DPI 下都不会发糊；引擎的自动巡演、指针跟随、
 * 点击逗弄原样保留。
 *
 * 开关（自动巡演 / 跟随指针）统一走 @poietica/core 的 createPreference。
 * 设置面板写入后通过一个只携带布尔快照的窗口事件通知当前吉祥物；其他窗口的
 * 变化则由 Preference 自己订阅。吉祥物重新挂载时会重新读取持久化值。
 */

const PREF_TOUR = 'poietica.mascot.autoTour'
const PREF_FOLLOW = 'poietica.mascot.followPointer'
const PREFS_EVENT = 'poietica:mascot-prefs'
const MASCOT_PAGE = '/mascot.html'

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
  const frame = useRef<HTMLIFrameElement | null>(null)

  /*
   * 每次挂载重新建立实例。
   *
   * 设置页可能在吉祥物卸载期间改值；重新挂载时重新读取，避免模块级缓存停在旧值。
   */
  const [tourPreference] = useState(() => booleanPreference(PREF_TOUR))
  const [followPreference] = useState(() => booleanPreference(PREF_FOLLOW))

  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(message, '*')
  }, [])

  /* 初始偏好写进 src；之后的改动走 postMessage，不重载页面。 */
  const src = useMemo(() => {
    const tour = tourPreference.read() ? '1' : '0'
    const follow = followPreference.read() ? '1' : '0'

    return `${MASCOT_PAGE}?embed=1&tour=${tour}&follow=${follow}`
  }, [followPreference, tourPreference])

  /* 设置面板或其他窗口改动偏好时，转告 iframe 里的引擎。 */
  useEffect(() => {
    const forwardPreferences = () => {
      post({
        type: 'poietica-mascot-prefs',
        tour: tourPreference.read(),
        follow: followPreference.read(),
      })
    }

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

      tourPreference.write(detail.tour)
      followPreference.write(detail.follow)
    }

    const stopTour = tourPreference.subscribe(forwardPreferences)
    const stopFollow = followPreference.subscribe(forwardPreferences)

    window.addEventListener(PREFS_EVENT, adoptPreferences)

    return () => {
      window.removeEventListener(PREFS_EVENT, adoptPreferences)
      stopFollow()
      stopTour()
    }
  }, [followPreference, post, tourPreference])

  /*
   * 把整窗指针按比例转发进去，小家伙才看得到 iframe 之外的鼠标。
   *
   * 指针悬在 iframe 上方时事件由它自己收，这里收不到，恰好不会双写；
   * 两种来源之间的缝隙由引擎侧的弹簧焊平。rAF 合并，一帧至多一条。
   */
  useEffect(() => {
    let pending = 0

    const forwardPointer = (event: PointerEvent) => {
      if (pending !== 0) {
        return
      }

      pending = window.requestAnimationFrame(() => {
        pending = 0
        post({
          type: 'poietica-mascot-pointer',
          nx: event.clientX / Math.max(window.innerWidth, 1),
          ny: event.clientY / Math.max(window.innerHeight, 1),
        })
      })
    }

    window.addEventListener('pointermove', forwardPointer, { passive: true })

    return () => {
      window.removeEventListener('pointermove', forwardPointer)

      if (pending !== 0) {
        window.cancelAnimationFrame(pending)
      }
    }
  }, [post])

  return <iframe className={className} ref={frame} src={src} title="Poietica 吉祥物" />
})
