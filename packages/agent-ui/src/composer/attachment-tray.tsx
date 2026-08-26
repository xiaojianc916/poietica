import './attachment-tray.css'

import { useCallback, useMemo, useState } from 'react'
import { ImageLightbox, type PreviewableImage } from '../media/image-lightbox'
import { CloseIcon, FileIcon, SpinnerIcon } from '../primitives/icons'
import { usePromptInputActions, usePromptInputAttachments } from './prompt-input'

/*
 * 输入框里攒着的附件，一格一张。
 *
 * 这一层只画那份草稿。附件的唯一所有者是 PromptInput（见 prompt-input.tsx 的
 * AttachmentsContext），移除也只经过它交出的 removeAttachment —— 原生注册表里
 * 那份字节由那条路负责放掉，这里不认识原生，也不持有第二份清单。
 *
 * 名字与媒体类型不再印在屏幕上：那是文件管理器的语言，占掉整行宽度却不回答
 * 「我贴的是哪张图」。名字挂在这一格的 title 上，指针停一下就读得到。
 */

/* 一格画什么由它那张图说了算，所以状态住在这一格里，不在上面。 */
type TileState = 'loading' | 'ready' | 'failed'

/* 这格文件叫什么类型。扩展名是人认得的那个词，去掉点、大写、截短。 */
function fileTypeLabel(filename: string): string {
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 ? filename.slice(dot + 1) : ''

  return extension === '' ? '文件' : extension.slice(0, 4).toUpperCase()
}

/* 没有预览可给的那一格：纯色底，一个字形，一行类型名。同一件事，同一段代码。 */
function TileFallback({ filename }: { readonly filename: string }) {
  return (
    <span className="composer-tile__face composer-tile__file">
      <FileIcon aria-hidden="true" className="composer-tile__mark" />
      <span className="composer-tile__type">{fileTypeLabel(filename)}</span>
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

  /*
   * 挂载那一刻向元素问一次，而不是只等 load 事件。
   *
   * 命中缓存的图在 React 绑上处理器之前就已经解码完，那一次 load 不会再来 ——
   * 只等事件的写法会把它永远停在转圈上。HTML 标准 §4.8.3 给的判据就是这两样：
   * complete 为真表示这张图已经有结果，失败的那一支 naturalWidth 为 0。
   *
   * 地址是内容寻址的，一格的 src 不会中途换掉（换了就是另一个 assetToken，
   * 也就是另一个 key），所以这个回调不需要跟着 src 重建。
   */
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

      {state === 'loading' ? (
        <SpinnerIcon aria-hidden="true" className="composer-tile__spinner" />
      ) : null}
    </button>
  )
}

export function AttachmentTray() {
  const attachments = usePromptInputAttachments()
  const { removeAttachment } = usePromptInputActions()
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  /*
   * 灯箱只装图片，编号也只在图片之间连续。混排时拿附件下标当幻灯片下标，左右键
   * 会翻到一张不存在的幻灯片 —— 一个 PDF 夹在两张图中间就够了。
   */
  const images = useMemo<readonly PreviewableImage[]>(
    () =>
      attachments.flatMap((attachment) =>
        attachment.mediaType.startsWith('image/')
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
    [attachments],
  )

  /* 一次建好「附件 → 幻灯片」的对照，而不是每格各扫一遍图片序列。 */
  const slides = useMemo(() => new Map(images.map((image, index) => [image.id, index])), [images])

  if (attachments.length === 0) {
    return null
  }

  return (
    <>
      <ul className="composer-tray" data-slot="composer-tray">
        {attachments.map((attachment) => {
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
      <ImageLightbox images={images} index={openIndex} onIndexChange={setOpenIndex} />
    </>
  )
}
