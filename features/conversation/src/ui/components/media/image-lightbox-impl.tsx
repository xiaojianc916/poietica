import Lightbox, { type Slide, type SlideImage } from 'yet-another-react-lightbox'
import Counter from 'yet-another-react-lightbox/plugins/counter'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/plugins/counter.css'
import 'yet-another-react-lightbox/styles.css'
import { useCallback, useMemo } from 'react'
import type { ImageLightboxProps, PreviewableImage } from './image-lightbox-types'
import './image-lightbox.css'

/* 插件表提成模块常量：内联数组每次渲染都是新引用，库会当成插件变了 */
const PLUGINS = [Zoom, Counter]

/**
 * Build lightbox slides from attachments.
 *
 * `SlideImage` declares `width?: number` (without `| undefined`), and this
 * workspace compiles with `exactOptionalPropertyTypes`. An absent dimension must
 * therefore be an absent *key*, not a key holding `undefined` — hence the
 * conditional spreads instead of a cast or a widened local type.
 */
const toSlides = (images: readonly PreviewableImage[]): Slide[] =>
  images.map((image): SlideImage => {
    const { width, height, caption } = image

    return {
      src: image.src,
      alt: image.alt ?? '',
      ...(width !== undefined && { width }),
      ...(height !== undefined && { height }),
      ...(caption !== undefined && { description: caption }),
    }
  })

/**
 * Fullscreen image preview. Controlled: the caller owns the open index, so the
 * same overlay can be driven from a thumbnail grid, a keyboard shortcut, or a
 * transcript message without duplicating state.
 *
 * carousel.padding 是显式给的，因为库的默认值是 "16px"：配上默认的
 * imageFit: "contain"，一张图会被放大到离窗口边缘只剩 16px，打开的第一眼是「顶
 * 满」而不是「看清」。取百分比而不是像素，是因为 computeSlideRect 按容器宽度折
 * 算它 —— 窗口拉大留白同比例跟随，一个数管所有窗口尺寸。
 *
 * 缩略图那两档尺寸不在这里：它们是列表里的物件，与打开后的观看尺度无关。
 */
export function ImageLightboxImpl({ images, index, onIndexChange }: ImageLightboxProps) {
  const slides = useMemo(() => toSlides(images), [images])
  const open = index !== null && index >= 0 && index < slides.length

  const handleClose = useCallback(() => {
    onIndexChange(null)
  }, [onIndexChange])

  if (slides.length === 0) {
    return null
  }

  return (
    <Lightbox
      animation={{ fade: 160, swipe: 260 }}
      carousel={{ finite: true, padding: '8%', preload: 1 }}
      className="poietica-lightbox"
      close={handleClose}
      controller={{ closeOnBackdropClick: true, closeOnPullDown: true }}
      index={open ? index : 0}
      on={{ view: ({ index: next }) => onIndexChange(next) }}
      open={open}
      plugins={PLUGINS}
      slides={slides}
      styles={{ container: { backdropFilter: 'blur(2px)' } }}
      zoom={{ maxZoomPixelRatio: 4, scrollToZoom: true }}
    />
  )
}
