import './message-attachments.css'

import { useMemo, useState } from 'react'
import type { MessageFile, MessageImage } from '../../timeline/timeline-contract'
import { ImageLightbox } from '../media/image-lightbox'
import { FileIcon, SpinnerIcon } from '../primitives/icons'

/**
 * 一句话带的附件，排在这句话上面、气泡外面。
 *
 * 气泡是那句话的形状 —— 它的宽度贴着文字（timeline.css 里的 fit-content），把
 * 附件塞进去，气泡就被撑成一个附件框，而那句话反倒成了附件的说明文字。附件是
 * 一件事，话是另一件事，挨着放，不套在一起。通用文件是宽卡片（图标 + 名字 +
 * 「类型 大小」），图片是一排方块缩略图；文件不拍平成正文，也不内联内容。
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
export function MessageAttachments({
  files,
  images,
}: {
  readonly files?: readonly MessageFile[] | undefined
  readonly images?: readonly MessageImage[] | undefined
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const hasFiles = (files?.length ?? 0) > 0
  const hasImages = (images?.length ?? 0) > 0

  /*
   * 灯箱只装已解析的图：还在代取字节的占位不是幻灯片。同时记住每张缩略图落在
   * 幻灯片里的第几位 —— 混排时两者不是同一个下标（占位不进灯箱）。
   */
  const { slides, slideAt } = useMemo(() => {
    const listed: { src: string; alt: string }[] = []
    const positions = new Map<number, number>()
    ;(images ?? []).forEach((image, at) => {
      if (image.url === undefined) {
        return
      }
      positions.set(at, listed.length)
      listed.push({ src: image.url, alt: `图片 ${String(at + 1)}` })
    })
    return { slides: listed, slideAt: positions }
  }, [images])

  if (!hasFiles && !hasImages) {
    return null
  }

  return (
    <>
      {hasFiles ? (
        <div className="timeline-files">
          {files?.map((file, at) => (
            <div className="timeline-file" key={`${String(at)}:${file.name}`} title={file.name}>
              <span className="timeline-file__icon">
                <FileIcon aria-hidden="true" />
              </span>
              <span className="timeline-file__text">
                <span className="timeline-file__name">{file.name}</span>
                <span className="timeline-file__meta">{file.meta}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {hasImages ? (
        <div className="timeline-attachments">
          {images?.map((image, at) =>
            image.url === undefined ? (
              <span
                aria-label="图片加载中"
                className="timeline-attachments__pending"
                key={`pending:${String(at)}`}
                role="img"
              >
                <SpinnerIcon aria-hidden="true" />
              </span>
            ) : (
              <button
                className="timeline-attachments__item"
                /* 内容寻址之后同一张图的 URL 逐字相同：一句话里发两次，光靠 URL
                   就是两个一样的 key。位置参与身份，撞不了。 */
                key={`${String(at)}:${image.url}`}
                onClick={() => {
                  setOpenIndex(slideAt.get(at) ?? null)
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
            ),
          )}
        </div>
      ) : null}

      <ImageLightbox images={slides} index={openIndex} onIndexChange={setOpenIndex} />
    </>
  )
}
