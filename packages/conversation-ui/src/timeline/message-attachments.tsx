import './message-attachments.css'

import type { MessageImage } from '@poietica/conversation'
import { useMemo, useState } from 'react'
import { ImageLightbox } from '../media/image-lightbox'

/**
 * 一句话带的图，排在这句话上面。
 *
 * 不在气泡里。气泡是那句话的形状 —— 它的宽度贴着文字（timeline.css 里的
 * fit-content），把一排缩略图塞进去，气泡就被撑成一个图片框，而那句话反倒
 * 成了图片的说明文字。附件是一件事，话是另一件事，挨着放，不套在一起。
 */

/**
 * 大图是这一排的兄弟，不是它的孩子。
 *
 * 上一版把它写在那排 flex 里面。关着的时候它不画任何东西，却仍然是一个 flex
 * 子项、仍然算进容器的 fit-content 宽度 —— 容器右缘贴着列的右缘没错，可右边
 * 那一截被一个隐形子项占着，图片被 justify-content: flex-end 推到了它左边。
 *
 * 它本来也不属于这一排：它是一层盖住整个窗口的浮层，只是恰好由这些缩略图
 * 触发。位置上的从属关系写反了，布局就会替它付账。
 */
export function MessageAttachments({ images }: { readonly images: readonly MessageImage[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  /* 大图那一层要的是幻灯片，不是我们的条目；转换记住，别每帧重建。 */
  const slides = useMemo(
    () => images.map((image, at) => ({ src: image.url, alt: `图片 ${String(at + 1)}` })),
    [images],
  )

  return (
    <>
      <div className="timeline-attachments">
        {images.map((image, at) => (
          <button
            className="timeline-attachments__item"
            /* 内容寻址之后同一张图的 URL 逐字相同：一句话里发两次，光靠 URL
               就是两个一样的 key。位置参与身份，撞不了。 */
            key={`${String(at)}:${image.url}`}
            onClick={() => {
              setOpenIndex(at)
            }}
            type="button"
          >
            {/* 缩略图不参与懒加载：它就在视口里，而且已经在内存里了。 */}
            <img
              alt={`图片 ${String(at + 1)}`}
              className="timeline-attachments__image"
              decoding="async"
              draggable={false}
              src={image.url}
            />
          </button>
        ))}
      </div>

      <ImageLightbox images={slides} index={openIndex} onIndexChange={setOpenIndex} />
    </>
  )
}
