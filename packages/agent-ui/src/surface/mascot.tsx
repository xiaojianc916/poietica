import { memo, useCallback, useEffect, useMemo, useRef } from 'react'

/*
 * 欢迎页的吉祥物。
 *
 * 本体是 apps/desktop/public/mascot.html —— 根目录 index.html 的嵌入版，由
 * 仓库根的 refactor.mjs 生成，整套 SVG 动画引擎自成一页，这里用同源 iframe
 * 承载：纯矢量渲染，任何尺寸与 DPI 下都不会发糊；引擎的自动巡演、指针跟随、
 * 点击逗弄原样保留。
 *
 * 开关（自动巡演 / 跟随指针）的真相在 localStorage：设置面板写，这里只读。
 * 两个包之间刻意不引 import —— 通道只有一对 web 原语（storage 键 + window
 * 事件）。键名与事件名在 packages/settings/src/surface/mascot-prefs.tsx 有
 * 一份逐字相同的副本，两处必须一起改。
 */

const PREF_TOUR = 'poietica.mascot.autoTour'
const PREF_FOLLOW = 'poietica.mascot.followPointer'
const PREFS_EVENT = 'poietica:mascot-prefs'
const MASCOT_PAGE = '/mascot.html'

/* 键缺席即开启：默认自动巡演、默认跟随指针。 */
function readPref(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== '0'
  } catch {
    return true
  }
}

export interface MascotBadgeProps {
  readonly className?: string | undefined
}

export const MascotBadge = memo(function MascotBadge({ className }: MascotBadgeProps) {
  const frame = useRef<HTMLIFrameElement | null>(null)

  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(message, '*')
  }, [])

  /* 初始偏好写进 src；之后的改动走 postMessage，不重载页面。 */
  const src = useMemo(() => {
    const tour = readPref(PREF_TOUR) ? '1' : '0'
    const follow = readPref(PREF_FOLLOW) ? '1' : '0'

    return `${MASCOT_PAGE}?embed=1&tour=${tour}&follow=${follow}`
  }, [])

  /* 设置面板拨动开关的那一刻，转告 iframe 里的引擎。 */
  useEffect(() => {
    const forwardPrefs = () => {
      post({
        type: 'poietica-mascot-prefs',
        tour: readPref(PREF_TOUR),
        follow: readPref(PREF_FOLLOW),
      })
    }

    window.addEventListener(PREFS_EVENT, forwardPrefs)

    return () => {
      window.removeEventListener(PREFS_EVENT, forwardPrefs)
    }
  }, [post])

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
