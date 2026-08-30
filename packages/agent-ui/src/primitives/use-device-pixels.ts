import { createExternalStore } from '@poietica/ui'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * 把一个 CSS 像素长度对齐到设备像素网格。
 *
 * 为什么需要它:CSS 像素不是设备像素。显示缩放 125% 时 1 CSS px 是 1.25 个设备像素,
 * 于是一条 1px 的边落在整数相位上是一行足墨、落在半个像素上是两行半墨 —— 同一条
 * 声明栅格化出两种边。实测:--ui-border 是 sRGB 224、背景 248,锐的那版量到
 * 1px #e0e0e0,糊的那版量到 2px #ececec,而 248-(248-224)/2=236 正是 #ececec。
 * 墨量守恒,不是两套样式。
 *
 * 为什么不用 CSS round():它对齐的是 CSS 像素网格,而这里的相位在设备网格上。
 *
 * 为什么用 matchMedia 而不是 resize:dpr 变化不一定伴随 resize —— 窗口被拖到另一块
 * 缩放不同的屏上时尺寸可以不变。查询串匹配的是当前 dpr,dpr 一变它就不再匹配,change
 * 因此触发;订阅随之按新值重建。这是观察 dpr 的标准做法。
 *
 * 为什么是外部数据源,而不是 useState:dpr 是 React 之外的可变事实,而官方给这类事实
 * 的接口只有 useSyncExternalStore。用 useState 存一份副本,并发渲染下这一帧读到的与
 * 提交时刻的真实值可以不是同一个(tearing),而 useEffect 里的首次同步永远晚一帧。
 *
 * 而这条管线已经有了:@poietica/ui 的 external-store 开篇那句「React 之外的
 * 数据源,接线只有这一种形状」说的就是这件事,threads/clock 用的正是它。
 *
 * dpr 是进程级的唯一事实,所以监听者也只有一个:每个使用点各持一份 state 与一个
 * matchMedia 监听者的话,一屏十几个思考盒就是十几份。
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
