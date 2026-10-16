import './attachment-tray.css'

import { useCallback, useMemo, useState } from 'react'
import { ImageLightbox, type PreviewableImage } from '../../shared/media/image-lightbox'
import { CloseIcon, FileIcon, SpinnerIcon } from '../../shared/primitives/icons'
import { fileMetaLabel } from '../../shared/timeline/timeline-contract'
import { isInlineAttachment } from '../attachment'
import { usePromptInputActions, usePromptInputAttachments } from './prompt-input'

/* 这一排只剩图片：通用文件与元素上下文在正文里各是一枚记号（prompt-chip.tsx），那枚记号就是它们的移除键，所以让出去。 */

type TileState = 'loading' | 'ready' | 'failed'

function TileFallback({ filename }: { readonly filename: string }) {
  return (
    <span className="composer-tile__face composer-tile__file">
      <FileIcon aria-hidden="true" className="composer-tile__mark" />
      <span className="composer-tile__type">{fileMetaLabel(filename, undefined)}</span>
    </span>
  )
}
interface AttachmentThumbnailProps {
  readonly filename: string
  readonly onOpen: () => void
  readonly src: string
}

function AttachmentThumbnail({ filename, onOpen, src }: AttachmentThumbnailProps) {
  const [state, setState] = useState<TileState>('loading')

  /* 挂载时向元素问一次：命中缓存的图在 React 绑处理器前已解码完，load 不会再来，只等事件会永远停在转圈上。判据是 HTML 标准的 complete 与 naturalWidth === 0。 */
  const readElement = useCallback((element: HTMLImageElement | null) => {
    if (element?.complete === true) {
      setState(element.naturalWidth === 0 ? 'failed' : 'ready')
    }
  }, [])

  if (state === 'failed') {
    return <TileFallback filename={filename} />
  }

  return (
    <button
      aria-busy={state === 'loading'}
      aria-label={`预览 ${filename}`}
      className="composer-tile__face composer-tile__open"
      onClick={onOpen}
      type="button"
    >
      <img
        alt=""
        className="composer-tile__image"
        data-state={state}
        decoding="async"
        draggable={false}
        onError={() => {
          setState('failed')
        }}
        onLoad={() => {
          setState('ready')
        }}
        ref={readElement}
        src={src}
      />

      {state === 'loading' ? <SpinnerIcon aria-hidden="true" className="composer-tile__spinner" /> : null}
    </button>
  )
}

export function AttachmentTray() {
  const attachments = usePromptInputAttachments()
  const { removeAttachment } = usePromptInputActions()
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const images = useMemo(() => attachments.filter((attachment) => !isInlineAttachment(attachment)), [attachments])

  /* 灯箱只装图片，编号也只在图片之间连续。判据是进门分类 kind，不是嗅探出来的 mediaType。 */
  const slideshow = useMemo<readonly PreviewableImage[]>(
    () =>
      images.flatMap((attachment) =>
        attachment.kind === 'image'
          ? [
              {
                id: attachment.assetToken,
                src: attachment.url,
                alt: attachment.filename,
                caption: attachment.filename,
              },
            ]
          : [],
      ),
    [images],
  )

  const slides = useMemo(() => new Map(slideshow.map((image, index) => [image.id, index])), [slideshow])

  if (images.length === 0) {
    return null
  }

  return (
    <>
      <ul className="composer-tray" data-slot="composer-tray">
        {images.map((attachment) => {
          const slide = slides.get(attachment.assetToken)

          return (
            <li className="composer-tile" key={attachment.assetToken} title={attachment.filename}>
              {slide === undefined ? (
                <TileFallback filename={attachment.filename} />
              ) : (
                <AttachmentThumbnail
                  filename={attachment.filename}
                  onOpen={() => {
                    setOpenIndex(slide)
                  }}
                  src={attachment.url}
                />
              )}

              <button
                aria-label={`移除 ${attachment.filename}`}
                className="composer-tile__remove"
                onClick={() => {
                  removeAttachment(attachment.assetToken)
                }}
                type="button"
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </li>
          )
        })}
      </ul>

      {/* 灯箱是幻灯片层，不是列表项：ul 的孩子只能是 li。 */}
      <ImageLightbox images={slideshow} index={openIndex} onIndexChange={setOpenIndex} />
    </>
  )
}
