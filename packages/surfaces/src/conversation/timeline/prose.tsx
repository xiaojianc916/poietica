import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import 'katex/dist/katex.min.css'
import { memo } from 'react'
import {
  type AnimateOptions,
  type ControlsConfig,
  type IconMap,
  type LinkSafetyConfig,
  type PluginConfig,
  Streamdown,
  type StreamdownTranslations,
} from 'streamdown'
import 'streamdown/styles.css'

import { cx } from '../primitives/class-names'
import { asIcon, CheckIcon, CopyIcon, DownloadIcon } from '../primitives/icons'
import { DIAGRAM_RENDERER } from './diagram'
import { ExportableTable } from './table-export'

/*
 * 行内公式用一个美元号：模型输出的是 LaTeX 惯例，而上游默认只认 $$…$$。不认行内
 * 那一半，整段会掉回 GFM 处理 —— 下划线隔空配对成斜体、转义符被吃掉，屏幕上出现的
 * 不是「公式没渲染」，是一段被拆碎的残字。代价是成对货币可能被误认，那在编程与
 * 研究场景里罕见。
 */
const MATH = createMathPlugin({ singleDollarTextMath: true })

/*
 * 一份插件表，整条流共用。
 *
 * code 与 renderers 不是解析通道，是围栏落地时才被消费的句柄（上游经 PluginContext
 * 交给 CodeBlock）：按块摘掉它们省不下任何解析，却会让 shikiTheme 在两组插件之间
 * 跳变 —— 它的回落链是 shikiTheme ?? plugins.code.getThemes() ?? 内置主题，缺 code
 * 的那一组拿到的是另一套配色。
 */
const PLUGINS: PluginConfig = { cjk, code, math: MATH, renderers: [DIAGRAM_RENDERER] }

/*
 * 复制一段代码是一个动作，把它存成 file.txt 不是。表格另说：结构化输出该能进表格与
 * 文档。图片的悬浮层与下载按钮一并关掉 —— 看图归 media/image-lightbox，而那套控件的
 * 外观全在上游的 Tailwind 工具类里，这份产物里没有那些类。
 */
const CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  image: false,
  table: { copy: true, download: true, fullscreen: false },
}

/* 上游默认标签是英文，落在中文界面上是语言混用。只翻当前配置真的会显示的那些。 */
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
  imageNotAvailable: '图片无法显示',
  tableFormatCsv: 'CSV',
  tableFormatMarkdown: 'Markdown',
}

/*
 * 控件里的图标也归这个应用：icons 收 Partial<IconMap>，是官方的统一覆盖点。每一枚过
 * 一道 asIcon —— 图标槽收组件本身，而图标库的 props 类型不收 undefined。
 */
const ICONS: Partial<IconMap> = {
  CheckIcon: asIcon(CheckIcon),
  CopyIcon: asIcon(CopyIcon),
  DownloadIcon: asIcon(DownloadIcon),
}

/*
 * 外链不在这一层拦：apps/desktop 的 src/chrome/external-links.ts 已在 document 的
 * capture 阶段接管全部外链，链接从不在 webview 里导航。默认那个确认框因此不保护任何
 * 东西，只是在系统浏览器已经打开之后多要一次点击。
 */
const LINK_SAFETY: LinkSafetyConfig = { enabled: false }

/*
 * 围栏的高度上限交给这个 prop，不再交给样式表：只有上游解析出高度，它才给那个滚动盒
 * 挂末端锚定（usePinnedScroll），一段正在被写出来的长代码才跟着走到底。值仍是同一个
 * 令牌 —— prop 收字符串并原样落进 max-height。
 */
const CODE_CAP = 'var(--cp-timeline-code-cap)'

/* 表格纵向不封顶（理由在 timeline.css），显式关掉上游 300px 的默认值。 */
const TABLE_CAP = 0
const COMPONENTS = { table: ExportableTable }

/*
 * 揭示按字，不按词。
 *
 * 上游的分词判据是 /\s/，中文一段里没有空白：整段因此是一个单元，它的起点恒在已提交
 * 长度之前，于是第二拍起 skipAnimation 恒真、时长归零 —— 动画等于没开，文字按帧到达
 * 的粒度硬跳。按字切分才让每一拍新到的那几个字成为新单元。
 *
 * 一拍里有多个单元，也是上游那条共享挂钟能压缩的前提：模型快过 stagger 时它把这一批
 * 压进 maxBacklogMs 的预算里，而不是把揭示排到队尾。所以这几个数说的是「慢时多平滑」
 * 与「快时最多落后多久」，不是速度上限。
 *
 * 模块级常量：上游按引用比较 animated，内联对象等于每次父级渲染都重算整棵子树。
 */
const REVEAL: AnimateOptions = {
  duration: 120,
  easing: 'ease-out',
  maxBacklogMs: 160,
  sep: 'char',
  stagger: 12,
}

export interface ProseProps {
  readonly text: string
  /** 只有仍在追加的尾项为 true；静态历史不重新播放动画。 */
  readonly streaming?: boolean
  /** A place in the timeline, for measure and scale. Never for typography. */
  readonly className?: string
}

/**
 * 模型输出的 markdown。文本与流式状态都来自 timeline；Streamdown 独占语法补全、分块、
 * 逐块记忆与新词排期。这一层不复制文本、不维护揭示游标，结束时只关闭动画。
 */
export const Prose = memo(function Prose({ className, streaming = false, text }: ProseProps) {
  return (
    <Streamdown
      animated={REVEAL}
      className={cx('timeline-prose', className)}
      codeBlockMaxHeight={CODE_CAP}
      components={COMPONENTS}
      controls={CONTROLS}
      icons={ICONS}
      isAnimating={streaming}
      lineNumbers={false}
      linkSafety={LINK_SAFETY}
      plugins={PLUGINS}
      tableMaxHeight={TABLE_CAP}
      translations={TRANSLATIONS}
    >
      {text}
    </Streamdown>
  )
})
