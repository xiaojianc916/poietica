import './prompt-queue.css'

import { Tooltip, TooltipContent, TooltipTrigger } from '@poietica/design-system'
import { memo, type ReactNode, type SVGProps, useCallback, useState, useSyncExternalStore } from 'react'
import { ImageLightbox, type PreviewableImage } from '../../shared/media/image-lightbox'
import type { MessageQueue, MessageQueueState } from '../../shared/model/message-queue'
import type {
  PromptDelivery,
  QueuedAttachment,
  QueuedDelivery,
  QueuedItem,
  WithdrawnMessage,
} from '../../shared/model/session'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FileIcon,
  ImageIcon,
  QueueSteerIcon,
  TrashIcon,
} from '../../shared/primitives/icons'

/* 图标库没有这张字形，就近画在用它这一处。 */
function QueueGlyph({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"

      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M5 6.75H11" stroke="currentColor" />
      <path d="M5 9H8" stroke="currentColor" />
      <path
        d="M2.37067 11.2497C1.5872 9.89252 1.32042 8.29798 1.61945 6.7597C1.91847 5.22141 2.76317 3.84293 3.99801 2.87809C5.23285 1.91325 6.7747 1.427 8.33964 1.50888C9.90458 1.59076 11.3873 2.23526 12.5147 3.32369C13.6422 4.41232 14.3384 5.8717 14.4751 7.43304C14.6118 8.99438 14.1797 10.5525 13.2585 11.8205C12.3372 13.0885 10.9889 13.9809 9.4617 14.3334C8.18666 14.6277 6.8587 14.529 5.64964 14.0601C5.17095 13.8745 4.76937 13.4929 4.26509 13.3963C3.67389 13.2832 2.95232 13.5595 2.0377 14.3334"
        stroke="currentColor"
      />
    </svg>
  )
}

export interface PromptQueueProps {
  readonly queue: MessageQueue
  /** 撤回那一句：正文与附件一起回输入框（只还正文，图就跟着那一句一起丢了）。 */
  readonly onEdit: (restored: WithdrawnMessage) => void
}

/* tier 是屏幕上的字面（'插话' / '排队'），layer 是同一事实的机器那一面。 */
export interface QueueRow {
  readonly id: string
  readonly text: string
  readonly tier: string
  readonly layer: PromptDelivery
  readonly ordinal: number
  readonly last: boolean
  /** 这一句带的图（只收有预览地址的那些）：队列行画第一张缩略图，点开是这一组的灯箱。 */
  readonly images: readonly PreviewableImage[]
  /** 这一句带的文件名（kind 'file'）：画成一枚文件记号，图以外的附件不再在队列条上隐身。 */
  readonly files: readonly string[]
  /** 正文为空时（只发了图 / 文件）正文位画的那句弱化摘要；有正文时为 null。 */
  readonly caption: string | null
}

/* 判据是进门分类 kind（与输入框那一排同口径）；还没有预览地址的图不画缩略图 —— 画出来也只是一块空底。 */
export function queueImages(attachments: readonly QueuedAttachment[]): readonly PreviewableImage[] {
  return attachments.flatMap((attachment) =>
    attachment.kind === 'image' && attachment.previewUrl !== null && attachment.previewUrl !== ''
      ? [{ id: attachment.id, src: attachment.previewUrl, alt: attachment.name, caption: attachment.name }]
      : [],
  )
}

export function queueFiles(attachments: readonly QueuedAttachment[]): readonly string[] {
  return attachments.flatMap((attachment) => (attachment.kind === 'file' ? [attachment.name] : []))
}

/* 只带附件、没打字的一句：正文位不留白（空白行读成「这一条丢了内容」），报它带了什么。数的是全部附件，还没预览地址的图也算。 */
export function queueCaption(text: string, attachments: readonly QueuedAttachment[]): string | null {
  if (text.trim() !== '') {
    return null
  }
  const images = attachments.filter((attachment) => attachment.kind === 'image').length
  const files = attachments.length - images
  const parts = [...(images > 0 ? [`${String(images)} 张图片`] : []), ...(files > 0 ? [`${String(files)} 个文件`] : [])]
  return parts.length > 0 ? parts.join('、') : '（空消息）'
}

function rowOf(item: QueuedItem, tier: string, layer: QueuedDelivery) {
  return {
    id: item.id,
    text: item.text,
    tier,
    layer,
    images: queueImages(item.attachments),
    files: queueFiles(item.attachments),
    caption: queueCaption(item.text, item.attachments),
  }
}

/* steering 先走、followUp 后走，两层接着数一个序号。 */
export function queueRows(state: MessageQueueState): readonly QueueRow[] {
  const rows = [
    ...state.steering.map((item) => rowOf(item, '插话', 'steer')),
    ...state.followUp.map((item) => rowOf(item, '排队', 'followUp')),
  ]

  return rows.map((row, index) => ({
    ...row,
    ordinal: index + 1,
    last: index === rows.length - 1,
  }))
}

/* 再点一次已经按下的那一枚就是收回、退回缺省；缺省那一档不画图标。 */
export function nextLayer(current: PromptDelivery | undefined, clicked: QueuedDelivery): QueuedDelivery | null {
  if (current === undefined) {
    return null
  }
  const target = current === clicked ? 'followUp' : clicked
  return target === current ? null : target
}

/* 换层两步之间快照里那一条真的不在，照快照画会整块卸载再长回来（闪一下）：搬动期间接在队尾画，正文一回到快照就让位（否则同一句话会画成两行）。 */
export function queueView(rows: readonly QueueRow[], moving: QueueRow | undefined): readonly QueueRow[] {
  if (moving === undefined || rows.some((row) => row.text === moving.text)) {
    return rows
  }

  return [...rows, { ...moving, ordinal: rows.length + 1, last: !rows.some((row) => row.last) }]
}

/* 只画不是缺省的那一档（缺省 followUp 不画图标：屏幕上没有图标就是它）；名字只在屏幕阅读器与悬停提示里。上游那档 aside 本仓不接：上游既不报它排在哪、也不报它何时被吃掉，画出来的行会永远留在屏幕上。 */
const DELIVERIES = [{ deliverAs: 'steer', label: '插话：插进正在跑的这一轮', Icon: QueueSteerIcon }] as const

/* 28 的圆钮，话在提示条里；按下的那一枚填成实心 —— 状态只由字形报，不铺底。 */
function QueueAction({
  active,
  children,
  disabled,
  label,
  onClick,
}: {
  readonly active?: boolean
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly label: string
  readonly onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={label}
            aria-pressed={active}
            className="prompt-queue__action"
            disabled={disabled === true}
            onClick={onClick}
            type="button"
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/*
 * 队列行里的缩略图（照 Codex / LobsterAI 的队列条）：高 24 吃在行的上下内边距里，带图不把这一行撑高；
 * 多张只画第一张，角上记 +N；点开是这一句那一组图的灯箱。图读不出来时退成一枚图片记号，不留空框。
 */
function QueueThumbnail({
  images,
  onOpen,
}: {
  readonly images: readonly PreviewableImage[]
  readonly onOpen: () => void
}) {
  const [failed, setFailed] = useState(false)
  const first = images[0]
  if (first === undefined) {
    return null
  }
  const more = images.length - 1
  const label = more > 0 ? `预览 ${String(images.length)} 张图片` : `预览 ${first.alt ?? '图片'}`

  return (
    <button aria-label={label} className="prompt-queue__thumb" onClick={onOpen} title={label} type="button">
      {failed ? (
        <ImageIcon aria-hidden className="prompt-queue__thumb-mark" size={14} />
      ) : (
        <img
          alt=""
          className="prompt-queue__thumb-image"
          decoding="async"
          draggable={false}
          onError={() => {
            setFailed(true)
          }}
          src={first.src}
        />
      )}
      {more > 0 ? (
        <span aria-hidden className="prompt-queue__thumb-more">
          +{more}
        </span>
      ) : null}
    </button>
  )
}

/* 队列行里的文件记号：与缩略图同高，只写第一个文件名，多个记 +N；全部文件名在悬停提示里。不带文件的行什么都不画。 */
function QueueFiles({ files }: { readonly files: readonly string[] }) {
  const first = files[0]
  if (first === undefined) {
    return null
  }
  const more = files.length - 1
  const label = files.join('\n')

  return (
    <span className="prompt-queue__file" title={label}>
      <FileIcon aria-hidden className="prompt-queue__file-mark" size={12} />
      <span className="prompt-queue__file-name">{first}</span>
      {more > 0 ? (
        <span aria-hidden className="prompt-queue__file-more">
          +{more}
        </span>
      ) : null}
    </span>
  )
}

/* 正文位：人打的话原样画；只发了附件时换成弱化的摘要（见 queueCaption）。 */
function QueueSaid({ row }: { readonly row: QueueRow }) {
  if (row.caption !== null) {
    return <span className="prompt-queue__said prompt-queue__said--caption">{row.caption}</span>
  }

  return (
    <span className="prompt-queue__said" title={row.text}>
      {row.text}
    </span>
  )
}

/* 只有最后一行画得出这两枚（它们改的正是最后那一条），其余行不给按不动的假键；current 缺了点下去屏幕上什么都不动，人读成「这键没反应」。 */
function RowDeliveries({
  current,
  disabled,
  onPick,
}: {
  readonly current: PromptDelivery | undefined
  readonly disabled: boolean
  readonly onPick: (deliverAs: QueuedDelivery) => void
}) {
  return (
    <>
      {DELIVERIES.map((delivery) => (
        <QueueAction
          active={current === delivery.deliverAs}
          disabled={disabled}
          key={delivery.deliverAs}
          label={delivery.label}
          onClick={() => {
            onPick(delivery.deliverAs)
          }}
        >
          <delivery.Icon aria-hidden size={14} />
        </QueueAction>
      ))}
    </>
  )
}

/** 顺序是 agent 的出队顺序，这一层不重排、不预演；撤回与换层按号点名，控件只画在最后一行（R-01）。 */
export const PromptQueue = memo(function PromptQueue({ onEdit, queue }: PromptQueueProps) {
  const state: MessageQueueState = useSyncExternalStore(queue.subscribe, queue.read, queue.read)
  const [collapsed, setCollapsed] = useState(false)
  /* 灯箱一次只开一行的那组图：存那一组本身，不存行号 —— 开着时队列前进了，图也不会换成别的那一句。 */
  const [preview, setPreview] = useState<{
    readonly images: readonly PreviewableImage[]
    readonly index: number
  } | null>(null)
  const turnPreview = useCallback((index: number | null) => {
    setPreview((current) => (index === null || current === null ? null : { ...current, index }))
  }, [])

  /* 正在换层的那一条：不是队列的第二份，是这次操作的落点（搬动期间照它画，见 queueView）。 */
  const [moving, setMoving] = useState<QueueRow | undefined>(undefined)
  const pending = moving !== undefined

  const rows = queueRows(state)
  const visible = queueView(rows, moving)

  /* 两枚控件改的都是最后那一条，它的层就是「当前那一层」。 */
  const last = visible.find((row) => row.last)

  /* 换层走服务端 queue.move：用账本里的原始输入重新入队，图片 / 文件 / 技能都保留（R-01）。 */
  const redeliver = useCallback(
    (deliverAs: QueuedDelivery) => {
      const target = nextLayer(last?.layer, deliverAs)
      if (pending || last === undefined || target === null) {
        return
      }
      setMoving(last)
      void queue.move(last.id, target).finally(() => {
        setMoving(undefined)
      })
    },
    [last, pending, queue],
  )

  const withdraw = useCallback(() => {
    if (last === undefined) {
      return
    }
    void queue.withdraw(last.id).then((restored) => {
      if (restored !== null) {
        onEdit(restored)
      }
    })
  }, [last, onEdit, queue])

  const toggle = useCallback(() => {
    setCollapsed((value) => !value)
  }, [])

  if (visible.length === 0) {
    return null
  }

  /* 折叠头两行以上才画：为一行再点一次头是白收一次，那一行本来就摊着。 */
  const expanded = !collapsed
  const listVisible = visible.length === 1 || expanded
  const many = visible.length > 1

  return (
    <div className="prompt-queue" data-queue-dock>
      <div className="prompt-queue__panel">
        {many ? (
          <div className="prompt-queue__header">
            <button
              aria-controls="prompt-queue-list"
              aria-expanded={expanded}
              className="prompt-queue__summary"
              onClick={toggle}
              type="button"
            >
              <span aria-hidden className="prompt-queue__lead">
                <QueueGlyph />
              </span>
              <span className="prompt-queue__count">{visible.length} 条排队消息</span>
            </button>

            {/* 两枚控件都改最后那一条（底层已支持任意一行，这里按位置的产品选择放在一处）：把撤回单独留在最后一行，会读成「只有这一行能删」。 */}
            {last === undefined ? null : (
              <>
                <RowDeliveries current={last.layer} disabled={pending} onPick={redeliver} />
                <QueueAction disabled={pending} label="撤回最后一条，正文回输入框" onClick={withdraw}>
                  <TrashIcon aria-hidden size={14} />
                </QueueAction>
              </>
            )}

            {/* 折角放队尾：它只说「这一块能收起来」，夹在按钮中间会被当成第四枚操作。 */}
            <button
              aria-controls="prompt-queue-list"
              aria-expanded={expanded}
              aria-label={expanded ? '收起排队消息' : '展开排队消息'}
              className="prompt-queue__chevron"
              onClick={toggle}
              type="button"
            >
              {expanded ? <ChevronDownIcon size={14} /> : <ChevronUpIcon size={14} />}
            </button>
          </div>
        ) : null}

        <ul className="prompt-queue__list" hidden={!listVisible} id="prompt-queue-list">
          {listVisible
            ? visible.map((row) => (
                <li className="prompt-queue__row" key={row.id}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className={many ? 'prompt-queue__ordinal' : 'prompt-queue__lead'}>
                          {many ? row.ordinal : <QueueGlyph />}
                        </span>
                      }
                    />
                    <TooltipContent side="bottom">
                      {many ? `${row.tier} · 第 ${String(row.ordinal)} 条` : row.tier}
                    </TooltipContent>
                  </Tooltip>

                  {/* 不带图的行它自己什么都不画：这一行的布局与改前一样。 */}
                  <QueueThumbnail
                    images={row.images}
                    onOpen={() => {
                      setPreview({ images: row.images, index: 0 })
                    }}
                  />

                  <QueueFiles files={row.files} />

                  <QueueSaid row={row} />

                  {/* 一行时没有折叠头，两枚控件贴这一行的右缘（它们改的就是这一条）。 */}
                  {many || !row.last ? null : (
                    <>
                      <RowDeliveries current={row.layer} disabled={pending} onPick={redeliver} />
                      <QueueAction disabled={pending} label="撤回最后一条，正文回输入框" onClick={withdraw}>
                        <TrashIcon aria-hidden size={14} />
                      </QueueAction>
                    </>
                  )}
                </li>
              ))
            : null}
        </ul>
      </div>

      {/* 灯箱是幻灯片层，不是列表项：ul 的孩子只能是 li。 */}
      <ImageLightbox images={preview?.images ?? []} index={preview?.index ?? null} onIndexChange={turnPreview} />
    </div>
  )
})
