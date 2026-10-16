import { useCallback, useSyncExternalStore } from 'react'
import { createExternalStore } from './external-store'

/**
 * 实测同一条 `1px` 声明：整数相位量到 1px #e0e0e0，半相位量到 2px #ececec。不用 CSS round()，它对齐的是 CSS 网格，这里的相位在设备网格上。
 * 监听用 matchMedia 而不是 resize：拖到另一块缩放的屏上时尺寸可以不变，dpr 却变了。dpr 走 useSyncExternalStore —— useState 存副本会在并发渲染下 tearing。
 */

let ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio

let query: MediaQueryList | undefined

const pixels = createExternalStore<number>({
  read: () => ratio,
  activate: () => {
    watch()

    return () => {
      query?.removeEventListener('change', resync)
      query = undefined
    }
  },
})

/** jsdom 没有 matchMedia：那里 dpr 恒为 1，取整是恒等变换，不订阅也正确。 */
function watch(): void {
  query = window.matchMedia?.(`(resolution: ${String(ratio)}dppx)`)
  query?.addEventListener('change', resync)
}

function resync(): void {
  query?.removeEventListener('change', resync)
  ratio = window.devicePixelRatio
  watch()
  pixels.notify()
}

export function useDevicePixels(): (px: number) => number {
  const scale = useSyncExternalStore(pixels.subscribe, pixels.read, pixels.read)

  return useCallback((px: number) => Math.round(px * scale) / scale, [scale])
}
