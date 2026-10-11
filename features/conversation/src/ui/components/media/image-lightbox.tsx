import { lazy, Suspense, useEffect } from 'react'
import type { ImageLightboxProps } from './image-lightbox-types'

export type { ImageLightboxProps, PreviewableImage } from './image-lightbox-types'

/*
 * 灯箱的轻壳（性能审查 P-06）。
 *
 * 灯箱库连同插件与样式约 100KB，以前被三处调用方静态带进入口闭包，每次启动都要解析；
 * 而且每条带图消息都常驻一个关着的实例。现在：
 *   - 库在独立的分块里，壳只在打开时挂载实现。关上时直接卸掉不影响淡出：库在自己的
 *     关闭动画放完之后才回调 onIndexChange(null)（yarl Portal 的 handleClose），旧代码里关着的
 *     实例同样什么都不画；
 *   - 画面上一出现缩略图就在空闲时预取分块，点开时通常已经就绪，不会多等一拍。
 */
const loadImpl = () => import('./image-lightbox-impl')
const Impl = lazy(() => loadImpl().then((m) => ({ default: m.ImageLightboxImpl })))

/** 空闲时预取一次；只为把点开那一下的等待挪走，失败了点开时会再试 */
let prefetched = false
function prefetchWhenIdle(): void {
  if (prefetched) return
  prefetched = true
  const run = (): void => {
    void loadImpl().catch(() => {
      prefetched = false
    })
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2_000 })
  else setTimeout(run, 0)
}

/**
 * Fullscreen image preview. Controlled: the caller owns the open index, so the
 * same overlay can be driven from a thumbnail grid, a keyboard shortcut, or a
 * transcript message without duplicating state.
 */
export function ImageLightbox(props: ImageLightboxProps) {
  const { images, index } = props
  const open = index !== null && index >= 0 && index < images.length

  const hasImages = images.length > 0
  useEffect(() => {
    if (hasImages) prefetchWhenIdle()
  }, [hasImages])

  if (!open) return null
  return (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  )
}
