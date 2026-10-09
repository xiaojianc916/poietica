import { useCallback, useSyncExternalStore } from 'react'
import { createExternalStore } from './external-store'

/**
 * 把一个 CSS 像素长度对齐到设备像素网格。
 *
 * CSS 像素不是设备像素：显示缩放 125% 时 1 CSS px 是 1.25 个设备像素，1px 的边落在
 * 整数相位是一行足墨、半相位是两行半墨 —— 实测同一条声明分别量到 1px #e0e0e0 与
 * 2px #ececec。不用 CSS round()：它对齐的是 CSS 网格，这里的相位在设备网格上。
 *
 * 用 matchMedia 而不是 resize：dpr 变化不一定伴随 resize —— 窗口拖到另一块缩放不同
 * 的屏上时尺寸可以不变；查询串匹配当前 dpr，dpr 一变它就失配，change 因此触发，
 * 订阅按新值重建。
 *
 * dpr 是 React 之外的可变事实，走外部数据源 + useSyncExternalStore：useState 存副本
 * 会在并发渲染下 tearing。dpr 是进程级唯一事实，监听者也只有一个 —— 使用点各持
 * 一份的话，一屏十几个思考盒就是十几份。
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

/** jsdom 没有 matchMedia。那里 dpr 恒为 1,取整是恒等变换,不订阅也正确。 */
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
