import Lightbox, { type Slide, type SlideImage } from 'yet-another-react-lightbox'
import Counter from 'yet-another-react-lightbox/plugins/counter'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/plugins/counter.css'
import 'yet-another-react-lightbox/styles.css'
import { useModalOverlay } from '@poietica/design-system'
import { useCallback, useMemo } from 'react'
import type { ImageLightboxProps, PreviewableImage } from './image-lightbox-types'
import './image-lightbox.css'

/* 插件表提成模块常量：内联数组每次渲染都是新引用，库会当成插件变了 */
const PLUGINS = [Zoom, Counter]

/** SlideImage 的 width/height 是可选的、且本仓开了 exactOptionalPropertyTypes：
 * 缺尺寸必须是「没有这个键」而不是「键为 undefined」，所以只能条件展开，不能转类型。 */
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

/** carousel.padding 必须显式给：库默认 "16px"，配默认的 imageFit: "contain" 会把图放大到
 * 离窗口只剩 16px，第一眼是「顶满」而不是「看清」。取百分比是因为 computeSlideRect 按容器宽度折算。 */
export function ImageLightboxImpl({ images, index, onIndexChange }: ImageLightboxProps) {
  const slides = useMemo(() => toSlides(images), [images])
  const open = index !== null && index >= 0 && index < slides.length
  /* 灯箱由库自己建传送门、铺满窗口：按模态浮层登记（浏览器面板的原生视图靠它让路） */
  useModalOverlay(open)

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
