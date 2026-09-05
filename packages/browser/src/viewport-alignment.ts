import type { BrowserViewportBounds } from './browser-port'

/*
 * 视口对齐：面板视口的矩形是原生子 webview 的摆放依据，这里是它唯一的测量处。
 *
 * 位置变化不进 ResizeObserver（侧栏开合、拖宽、窗口移动都只改位置），所以只能
 * 在帧上量；三个触发源都从 start 进来，一帧最多量一次，连续两帧不动就停机。
 */

/** 连续几帧不动算停。 */
const STILL_FRAMES = 2

export interface ViewportAlignment {
  /** 几何输入的指纹变了就重新起跑；同一个指纹只起跑一次。 */
  readonly follow: (signal: unknown) => void
  readonly stop: () => void
}

export function alignViewport(
  element: Element,
  report: (bounds: BrowserViewportBounds) => void,
): ViewportAlignment {
  let frame = 0
  let still = 0
  let last: BrowserViewportBounds | null = null
  let signal: unknown = null

  const measure = (): void => {
    const rect = element.getBoundingClientRect()

    if (
      last === null ||
      rect.x !== last.x ||
      rect.y !== last.y ||
      rect.width !== last.width ||
      rect.height !== last.height
    ) {
      last = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      still = 0
      report(last)
    } else if (++still >= STILL_FRAMES) {
      frame = 0

      return
    }

    frame = requestAnimationFrame(measure)
  }

  const start = (): void => {
    still = 0

    if (frame === 0) {
      frame = requestAnimationFrame(measure)
    }
  }

  const observer = new ResizeObserver(start)

  observer.observe(element)
  window.addEventListener('resize', start)
  start()

  return {
    follow: (next) => {
      if (next === signal) {
        return
      }

      signal = next
      start()
    },
    stop: () => {
      cancelAnimationFrame(frame)
      frame = 0
      observer.disconnect()
      window.removeEventListener('resize', start)
    },
  }
}
