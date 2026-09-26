import { FileTypeMark } from '@poietica/design-system'
import type { DiffFile, DiffRow, DiffRowKind } from '@poietica/review'
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ToolCallTimelineItem } from '../../timeline/timeline-contract'
import { ImageLightbox } from '../media/image-lightbox'
import { panelId, TabList, type TabOption, tabId } from '../primitives/tabs'
import { basename } from '../semantics/file-diff'
import { fencedBodyOf, type ToolImage, toToolCallFacets } from '../semantics/tool-call-facets'
import { Prose } from './prose'
import { VIRTUAL_ABOVE_LINES, VirtualLines } from './virtual-lines'

const REQUEST = 'request'
const RESPONSE = 'response'

const FACETS: readonly TabOption[] = [
  { id: REQUEST, label: '输入' },
  { id: RESPONSE, label: '输出' },
]

function emptyNoteOf(kind: ToolCallTimelineItem['kind'], isRunning: boolean): string {
  if (!isRunning) {
    return '这次调用没有返回内容。'
  }

  return kind === 'delegate' ? '子代理在自己那边干活，这里只记结果。' : '还在运行，暂时没有输出。'
}

function ToolPanel({
  images,
  labelledBy,
  panel,
  seam,
  text,
}: {
  readonly images?: readonly ToolImage[] | undefined
  readonly labelledBy?: string
  readonly panel?: string
  // 上下相接的第二面：与上面那条之间隔一条发丝线，说明这不是又一次调用。
  readonly seam?: boolean
  readonly text: string
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const lines = fencedBodyOf(text)

  return (
    <div
      className="timeline-tool__panel"
      data-scrollable=""
      data-seam={seam === true ? '' : undefined}
      ref={setViewport}
      {...(panel === undefined
        ? {}
        : { 'aria-labelledby': labelledBy, id: panel, role: 'tabpanel' })}
    >
      {lines !== null && lines.length > VIRTUAL_ABOVE_LINES ? (
        <VirtualLines
          className="timeline-tool__output"
          lineClassName="timeline-tool__output-line"
          lines={lines}
          viewport={viewport}
        />
      ) : (
        /*
         * 围栏在这里不封顶。
         *
         * Streamdown 把 codeBlockMaxHeight 写成**内联** maxHeight 加 overflow-y-auto
         * （它 dist 里的 HighlightedCodeBlockBody），内联样式盖不过样式表 —— 所以只在
         * CSS 里把上限摘掉是不够的，围栏仍会是面板里第二个滚动容器，屏幕上多出一条
         * 贴着自己底边的滚动条。0 是 Streamdown 自己的「禁用」值。
         *
         * 上限因此只由面板那一处持有（tool-call.css 的 __panel），长出来的部分归它滚。
         */
        <Prose className="timeline-tool__prose" codeBlockMaxHeight={0} text={text} />
      )}

      {(images?.length ?? 0) > 0 ? <ToolShots images={images ?? []} /> : null}
    </div>
  )
}

/**
 * 这一面里的图：浏览器的每一帧、桌面控制的那张快照、read 一张图、生成的图。
 *
 * 不走 markdown —— Streamdown 把 data URL 当可疑来源拦掉，屏幕上只剩一句「图片被
 * 拦截」。这里直接 <img>：base64 与 mimeType 就是这张图的正本。点击交给灯箱（与
 * 消息附件同一套），所以它不只是一个缩略图。
 */
function ToolShots({ images }: { readonly images: readonly ToolImage[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const slides = images.map((image, at) => ({
    src: `data:${image.mimeType};base64,${image.data}`,
    alt: `截图 ${String(at + 1)}`,
  }))

  return (
    <>
      <div className="timeline-tool__shots">
        {slides.map((shot, at) => (
          <button
            className="timeline-tool__shot"
            key={`${String(at)}:${shot.src.slice(-24)}`}
            onClick={() => {
              setOpenIndex(at)
            }}
            type="button"
          >
            <img alt={shot.alt} decoding="async" draggable={false} src={shot.src} />
          </button>
        ))}
      </div>

      <ImageLightbox images={slides} index={openIndex} onIndexChange={setOpenIndex} />
    </>
  )
}

const TINT: Readonly<Record<DiffRowKind, string>> = {
  added: 'var(--cp-timeline-diff-new)',
  context: 'transparent',
  gap: 'transparent',
  removed: 'var(--cp-timeline-diff-old)',
}

// 增删底色折成竖直渐变交给滚动容器铺（理由见 tool-call.css __diff）；一行 diff 一个行盒。
function fieldOf(rows: readonly DiffRow[]): string {
  const stops: string[] = []
  let kind: DiffRowKind | null = null
  let from = 0

  for (const row of rows) {
    if (row.kind === kind) {
      continue
    }

    if (kind !== null) {
      stops.push(`${TINT[kind]} ${from}lh ${row.at}lh`)
    }

    kind = row.kind
    from = row.at
  }

  if (kind !== null) {
    stops.push(`${TINT[kind]} ${from}lh ${rows.length}lh`)
  }

  return `linear-gradient(${stops.join(',')})`
}

const MIN_THUMB_PX = 24

function syncAxis(
  control: HTMLInputElement,
  client: number,
  total: number,
  position: number,
): void {
  const max = Math.max(0, total - client)

  control.hidden = max === 0
  control.max = String(max)
  control.value = String(Math.min(max, Math.max(0, position)))

  const thumb =
    client === 0 ? 0 : Math.min(client, Math.max(MIN_THUMB_PX, (client * client) / total))

  control.style.setProperty('--timeline-tool-thumb', `${String(thumb)}px`)
}

function DiffViewport({
  children,
  field,
}: {
  readonly children: ReactNode
  readonly field: CSSProperties
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const horizontal = useRef<HTMLInputElement>(null)
  const vertical = useRef<HTMLInputElement>(null)
  const viewportId = useId()

  const sync = useCallback(() => {
    const view = viewport.current
    const x = horizontal.current
    const y = vertical.current

    if (view === null || x === null || y === null) {
      return
    }

    syncAxis(x, view.clientWidth, view.scrollWidth, view.scrollLeft)
    syncAxis(y, view.clientHeight, view.scrollHeight, view.scrollTop)
  }, [])

  useLayoutEffect(sync)

  useLayoutEffect(() => {
    const view = viewport.current

    if (view === null) {
      return
    }

    const observer = new ResizeObserver(sync)
    observer.observe(view)

    return () => {
      observer.disconnect()
    }
  }, [sync])

  return (
    <div className="timeline-tool__diff-frame">
      <section
        aria-label="文件差异"
        className="timeline-tool__diff"
        data-scrollable=""
        id={viewportId}
        onScroll={sync}
        ref={viewport}
        style={field}
      >
        {children}
      </section>

      <input
        aria-controls={viewportId}
        aria-label="横向滚动文件差异"
        className="timeline-tool__diff-scrollbar timeline-tool__diff-scrollbar--x"
        defaultValue={0}
        min={0}
        onInput={(event) => {
          if (viewport.current !== null) {
            viewport.current.scrollLeft = event.currentTarget.valueAsNumber
          }
        }}
        ref={horizontal}
        type="range"
      />

      <input
        aria-controls={viewportId}
        aria-label="纵向滚动文件差异"
        className="timeline-tool__diff-scrollbar timeline-tool__diff-scrollbar--y"
        defaultValue={0}
        min={0}
        onInput={(event) => {
          if (viewport.current !== null) {
            viewport.current.scrollTop = event.currentTarget.valueAsNumber
          }
        }}
        ref={vertical}
        type="range"
      />
    </div>
  )
}

function FileDiff({ file }: { readonly file: DiffFile }) {
  const name = basename(file.path)
  const field = {
    '--cp-timeline-diff-field': fieldOf(file.rows),
    '--cp-timeline-diff-rows': String(file.rows.length),
  } as CSSProperties

  return (
    <div className="timeline-tool__file">
      <div className="timeline-tool__path" title={file.path}>
        <FileTypeMark className="timeline-tool__path-icon" name={name} />
        <span className="timeline-tool__path-name">{name}</span>
      </div>

      <DiffViewport field={field}>
        {file.rows.map((row) => (
          <div className="timeline-tool__diff-row" data-kind={row.kind} key={row.at}>
            <span className="timeline-tool__diff-line">{row.number ?? '⋯'}</span>
            <code className="timeline-tool__diff-code">{row.text}</code>
          </div>
        ))}
      </DiffViewport>
    </div>
  )
}

// 按 item.shape 分发：有改动画改动；result 只有产出面；flow 两面摞同一张纸；tabs 两页签。
export function ToolCallPanels({
  isRunning,
  item,
}: {
  readonly isRunning: boolean
  readonly item: ToolCallTimelineItem
}) {
  const { diffs, images, request, response } = toToolCallFacets(item)
  const baseId = useId()
  const [chosen, setChosen] = useState<string | null>(null)

  if (diffs.length > 0) {
    return (
      <div className="timeline-tool__body">
        {diffs.map((file) => (
          <FileDiff file={file} key={file.path} />
        ))}
      </div>
    )
  }

  const responseText = response ?? emptyNoteOf(item.kind, isRunning)

  /*
   * 图属于产出那一面。只有图、没有字时也得画出来 —— 一次截图调用的正文可能就一句
   * 「done」，而那张图才是产出；反过来缺了它，屏幕上只剩一句 done。
   */
  if (item.shape === 'result' || request === null) {
    return (
      <div className="timeline-tool__body">
        <ToolPanel images={images} text={responseText} />
      </div>
    )
  }

  if (item.shape === 'flow') {
    return (
      <div className="timeline-tool__body">
        <ToolPanel text={request} />
        <ToolPanel images={images} seam text={responseText} />
      </div>
    )
  }

  const activeId = chosen ?? (response === null ? REQUEST : RESPONSE)

  return (
    <div className="timeline-tool__body">
      <TabList
        activeId={activeId}
        baseId={baseId}
        className="timeline-tool__tabs"
        label="这次调用的两个面"
        onSelect={setChosen}
        options={FACETS}
      />

      <ToolPanel
        images={activeId === RESPONSE ? images : undefined}
        key={activeId}
        labelledBy={tabId(baseId, activeId)}
        panel={panelId(baseId, activeId)}
        text={activeId === REQUEST ? request : responseText}
      />
    </div>
  )
}
