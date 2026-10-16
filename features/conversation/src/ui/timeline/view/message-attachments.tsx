import './message-attachments.css'

import { useMemo, useState } from 'react'
import { ImageLightbox } from '../../shared/media/image-lightbox'
import { FileIcon, SpinnerIcon } from '../../shared/primitives/icons'
import type { MessageFile, MessageImage } from '../../shared/timeline/timeline-contract'

/**
 * 附件排在这句话上面、气泡外面：气泡宽度贴着文字，塞进去就会被附件撑成附件框，那句话反成了附件的说明文字。
 */

/**
 * 大图是这一排的兄弟，不是它的孩子。
 *
 * 写在那排 flex 里面时：关着不画任何东西，却仍是 flex 子项、仍算进容器宽度，右端被隐性占掉，图片被推走。
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

  /* 灯箱只装已解析的图（占位不是幻灯片），slideAt 记住每张缩略图在幻灯片里的第几位 —— 混排时两者下标不同。 */
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
                /* 内容寻址后同一张图的 URL 逐字相同：一句话里发两次，光靠 URL 就是两个一样的 key。 */
                key={`${String(at)}:${image.url}`}
                onClick={() => {
                  setOpenIndex(slideAt.get(at) ?? null)
                }}
                type="button"
              >
                {/* 缩略图不参与懒加载：它就在视口里，且已经在内存里。 */}
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
