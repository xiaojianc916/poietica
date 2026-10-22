import { FileTypeMark } from '@poietica/design-system'
import { basename, type DiffFile } from '@poietica/design-system/diff'
import { DiffBody } from '@poietica/design-system/diff/surface'
import { Prose } from '@poietica/design-system/prose'
import { useId, useRef, useState } from 'react'
import { ImageLightbox } from '../../../shared/media/image-lightbox'
import { panelId, TabList, type TabOption, tabId } from '../../../shared/primitives/tabs'
import { fencedBodyOf, type ToolImage, toToolCallFacets } from '../../../shared/semantics/tool-call-facets'
import type { ToolCallTimelineItem } from '../../../shared/timeline/timeline-contract'
import { VIRTUAL_ABOVE_LINES, VirtualLines } from '../virtual-lines'
import { usePaintedDiff } from './diff-painting'

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

  return kind === 'delegate' ? '子代理在自己那边干活，这里只记结果。' : 'Running...'
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
      {...(panel === undefined ? {} : { 'aria-labelledby': labelledBy, id: panel, role: 'tabpanel' })}
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
         * Streamdown 把 codeBlockMaxHeight 写成**内联** maxHeight 加 overflow-y-auto，内联样式盖不过样式表 —— 只在 CSS 里摘上限不够，围栏仍会是面板里第二个滚动容器。
         * 0 是 Streamdown 自己的「禁用」值。上限因此只由面板那一处持有（tool-call.css 的 __panel）。
         */
        <Prose className="timeline-tool__prose" codeBlockMaxHeight={0} text={text} />
      )}

      {(images?.length ?? 0) > 0 ? <ToolShots images={images ?? []} /> : null}
    </div>
  )
}

/**
 * 不走 markdown —— Streamdown 把 data URL 当可疑来源拦掉，屏幕上只剩一句「图片被拦截」。这里直接 <img>：base64 与 mimeType 就是这张图的正本。点击交给灯箱。
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

function FileDiff({ file }: { readonly file: DiffFile }) {
  const name = basename(file.path)
  const scroller = useRef<HTMLDivElement | null>(null)
  const shown = usePaintedDiff(file)

  return (
    <div className="timeline-tool__file">
      <div className="timeline-tool__path" title={file.path}>
        <FileTypeMark className="timeline-tool__path-icon" name={file.path} />
        <span className="timeline-tool__path-name">{name}</span>
      </div>

      {/*
       * 一处改动就是审查面板画的那一份行带（@poietica/design-system/diff/surface 的 DiffBody），
       * 不再自己排一套：行号槽、增删底色、语法色、大文件的虚拟化全仓一份。
       *
       * 语法色要自己跑着色器（diff-painting.ts）：computeFile 只切行、不认语法，不跑就整片
       * 是黑的 —— 审查面板有 worker 替它跑，这里没有。
       *
       * 两处只差横向出口归谁：这里归这一格 —— 它是唯一的双轴滚动容器，行带自己不再横滚
       * （scrollX 关掉），否则同一件事会在屏幕上并排出现两条横条。
       *
       * 折叠带也关掉（gaps）：这一处改动只取三行上下文，跳过的行根本没进这份模型。
       */}
      <section aria-label="文件差异" className="timeline-tool__diff" data-scrollable="" ref={scroller}>
        <DiffBody file={shown} gaps={false} scroller={scroller} scrollX={false} wrap={false} />
      </section>
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
   * 图属于产出那一面。只有图、没有字时也得画出来 —— 一次截图调用的正文可能就一句「done」，而那张图才是产出。
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
