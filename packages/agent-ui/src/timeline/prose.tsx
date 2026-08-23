import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import 'katex/dist/katex.min.css'
import { type ComponentProps, memo, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import {
  type AnimateOptions,
  type ControlsConfig,
  type IconMap,
  type LinkSafetyConfig,
  Streamdown,
  type StreamdownTranslations,
} from 'streamdown'

import { cx } from '../primitives/class-names'
import { asIcon, CheckIcon, CopyIcon, DownloadIcon } from '../primitives/icons'
import { DIAGRAM_RENDERER } from './diagram'
import { createBlockScanner, type Fence, type StreamBlock } from './split-stream'

/*
 * 行内公式用一个美元号：模型输出的是 LaTeX 惯例，而上游默认只认 $$…$$。
 *
 * 不认行内那一半，整段会掉回 GFM 处理 —— 下划线隔空配对成斜体、转义符被吃掉，
 * 屏幕上出现的不是「公式没渲染」，是一段被拆碎的残字。代价是成对货币可能被误认，
 * 那在编程与研究场景里罕见。
 */
const MATH = createMathPlugin({ singleDollarTextMath: true })

/* NonNullable：可选属性读出来带 undefined，会让 ?? 兜底后的类型仍然可空。 */
type Plugins = NonNullable<ComponentProps<typeof Streamdown>['plugins']>

/*
 * 插件按块挑，不按组件挂。
 *
 * 插件就是这一块要走的解析通道：一段纯文字挂上代码高亮与图表渲染器，等于为每一段
 * 文字各跑一遍它用不到的通道。围栏种类由切分器顺手交出（split-stream）。
 *
 * 有围栏的那一块照旧全挂 —— 切点只落在空行处，所以一块里可以既有文字又有围栏。
 *
 * 两张表都是模块级常量：memo 靠浅比较，每次渲染新造一个插件对象等于把它关掉。
 */
const FENCED: Plugins = { cjk, code, math: MATH, renderers: [DIAGRAM_RENDERER] }
const PLAIN: Plugins = { cjk, math: MATH }

const PLUGINS: Record<Fence, Plugins> = { code: FENCED, math: PLAIN, none: PLAIN }

/* 逐词的 filter 会随流变长而提层，透明度不会。 */
const ANIMATION: AnimateOptions = {
  animation: 'fadeIn',
  duration: 160,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  sep: 'word',
  stagger: 12,
}

/*
 * 复制一段代码是一个动作，把它存成 file.txt 不是。表格另说：结构化输出该能进表格
 * 与文档。每一项都点名写出，上游默认变化时不会悄悄多出一个表格动作。
 */
const CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: { copy: true, download: true, fullscreen: false },
}

/*
 * 上游默认标签是英文，落在中文界面上是语言混用。translations 收 Partial，所以这里
 * 只翻译当前配置真的会显示的控件。
 */
const TRANSLATIONS: Partial<StreamdownTranslations> = {
  copied: '已复制',
  copyCode: '复制代码',
  copyTable: '复制表格',
  copyTableAsCsv: '复制为 CSV',
  copyTableAsMarkdown: '复制为 Markdown',
  copyTableAsTsv: '复制为 TSV',
  downloadTable: '下载表格',
  downloadTableAsCsv: '下载为 CSV',
  downloadTableAsMarkdown: '下载为 Markdown',
  tableFormatCsv: 'CSV',
  tableFormatMarkdown: 'Markdown',
  imageNotAvailable: '图片无法显示',
}

/*
 * 控件里的图标也归这个应用：icons 收 Partial<IconMap>，是官方的统一覆盖点。
 *
 * 每一枚过一道 asIcon —— 图标槽收组件本身，而图标库的 props 类型不收 undefined
 *（见 primitives/icons.ts）。
 */
const ICONS: Partial<IconMap> = {
  CheckIcon: asIcon(CheckIcon),
  CopyIcon: asIcon(CopyIcon),
  DownloadIcon: asIcon(DownloadIcon),
}

/*
 * 外链不在这一层拦：apps/desktop 的 src/chrome/external-links.ts 已在 document 的
 * capture 阶段接管全部外链，链接从不在 webview 里导航。默认那个确认框因此不保护
 * 任何东西，只是在系统浏览器已经打开之后多要一次点击。
 */
const LINK_SAFETY: LinkSafetyConfig = { enabled: false }

function SegmentBody({
  fence,
  isStreaming,
  text,
}: {
  readonly fence: Fence
  readonly isStreaming: boolean
  readonly text: string
}) {
  return (
    <Streamdown
      {...(isStreaming ? { animated: ANIMATION } : {})}
      className="timeline-prose__segment"
      controls={CONTROLS}
      icons={ICONS}
      isAnimating={isStreaming}
      lineNumbers={false}
      linkSafety={LINK_SAFETY}
      mode={isStreaming ? 'streaming' : 'static'}
      plugins={PLUGINS[fence] ?? PLAIN}
      translations={TRANSLATIONS}
    >
      {text}
    </Streamdown>
  )
}

export interface ProseProps {
  readonly cacheKey: string
  readonly text: string
  readonly isStreaming: boolean
  /** A place in the timeline, for measure and scale. Never for typography. */
  readonly className?: string
}

const MARKDOWN_MEASURE = 'poietica:markdown-render'
const useCommitEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect

/* One application root owns every markdown subtree. Virtualization may unmount a row,
 * but no live React root or detached DOM tree survives outside that ownership graph. */
const ProseSegment = memo(function ProseSegment({
  cacheKey,
  fence,
  isStreaming,
  text,
}: {
  readonly cacheKey: string
  readonly fence: Fence
  readonly isStreaming: boolean
  readonly text: string
}) {
  const startedAt = performance.now()

  useCommitEffect(() => {
    performance.measure(MARKDOWN_MEASURE, {
      start: startedAt,
      end: performance.now(),
      detail: { cacheKey, characters: text.length, isStreaming },
    })

    if (performance.getEntriesByName(MARKDOWN_MEASURE).length > 512) {
      performance.clearMeasures(MARKDOWN_MEASURE)
    }
  }, [cacheKey, isStreaming, startedAt, text])

  return <SegmentBody fence={fence} isStreaming={isStreaming} text={text} />
})
/**
 * 模型输出的 markdown，无论它出现在哪里。
 *
 * 回答与思考链是同一种内容，所以由同一个组件画：timeline-prose 是样式表唯一装扮的
 * 作用域，思考链里的围栏因此本来就与回答里的一样。
 */
export const Prose = memo(function Prose({ cacheKey, className, isStreaming, text }: ProseProps) {
  /* 一条流一个切分器：进度跟着这个实例走，两条流同时在长时谁都顶不掉谁。 */
  const [split] = useState(createBlockScanner)

  /*
   * 切块与流没流无关：切点只由文本决定，isStreaming 只决定最后一块要不要走流式渲染。
   * 按 isStreaming 分岔会让块表在说完的那一刻从 n 块塌成 1 块，整篇连同高亮与公式在
   * 那一帧重解析一次。
   */
  const blocks = useMemo((): readonly StreamBlock[] => split(text), [split, text])

  return (
    <div
      className={cx('timeline-prose', className)}
      data-streaming={isStreaming ? 'true' : undefined}
    >
      {blocks.map((block, index) => (
        <ProseSegment
          cacheKey={`${cacheKey}:${String(block.key)}`}
          fence={block.fence}
          isStreaming={isStreaming && index === blocks.length - 1}
          key={block.key}
          text={block.text}
        />
      ))}
    </div>
  )
})
