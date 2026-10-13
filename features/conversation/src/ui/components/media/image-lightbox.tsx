import { lazy, Suspense, useEffect } from 'react'
import type { ImageLightboxProps } from './image-lightbox-types'

export type { ImageLightboxProps, PreviewableImage } from './image-lightbox-types'

/* 灯箱轻壳（性能审查 P-06）：库连同插件与样式约 100KB，只在打开时挂载实现 —— 关上时直接卸掉
 * 不影响淡出，因为库在自己的关闭动画放完后才回调 onIndexChange(null)（yarl Portal 的 handleClose）。 */
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
