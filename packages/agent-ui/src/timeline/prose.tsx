import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import 'katex/dist/katex.min.css'
import { memo, useMemo, useState } from 'react'
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
import { createBlockScanner, type StreamBlock } from './split-stream'

/*
 * 行内公式用一个美元号，因为模型就是这么写的。
 *
 * 上游默认只认 $$…$$（singleDollarTextMath 默认 false，官方 Syntax 一节逐字），
 * 理由是怕把「这个 $5、那个 $10」认成公式。代价却落在另一边：模型输出的是标准
 * LaTeX 惯例 —— 行内 $…$、块级 $$…$$ —— 于是行内那一半不被认作公式，整段掉回
 * GFM 去处理，_ 隔空配对成斜体、反斜杠被当转义吃掉、^ 与 * 各自被当成标记。
 * 屏幕上出现的不是「公式没渲染」，是一段被拆碎的斜体残字。
 *
 * 两害相权：行内公式崩坏是必然发生的，成对货币被误认是偶发的，而后者在一个
 * 编程与研究场景的客户端里本来就罕见。ChatGPT、Claude、Perplexity 一律支持
 * $…$，这已经是模型输出的事实标准。
 */
const MATH = createMathPlugin({ singleDollarTextMath: true })

/* 每一段文本都要走的四个。图那一条不带引擎：引擎在真的出现一张图时才取，取在 diagram.tsx。 */
const PROSE_PLUGINS = {
  cjk,
  code,
  math: MATH,
  renderers: [DIAGRAM_RENDERER],
}

/* Per-word filter work scales with the stream; opacity keeps the reveal compositor-friendly. */
const ANIMATION: AnimateOptions = {
  animation: 'fadeIn',
  duration: 160,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  sep: 'word',
  stagger: 12,
}

/*
 * Copying a code snippet is an action; saving it as file.txt is not.
 *
 * Tables are different: structured model output should be exportable for use in
 * spreadsheets and documents. Every control is still named explicitly so an
 * upstream default change cannot silently add another table action.
 */
const CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: { copy: true, download: true, fullscreen: false },
}

/*
 * 控件的中文标签。
 *
 * 上游的默认标签全部是英文，落在一个整体中文的界面上会形成语言混用。
 * translations 收的是 Partial，所以这里只翻译当前配置实际会显示的控件。
 *
 * 外链弹窗和表格全屏已经关闭，对应文案不在这里保留；表格下载菜单则完整翻译，
 * 避免触发按钮和格式选项退回英文。
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
 * 控件里的图标也归这个应用。
 *
 * 上游自带一套，代码块与表格的控件默认渲染的就是它们；而这个界面其余每一个图标都来自
 * @lucide/react。icons 收 Partial<IconMap>，是官方提供的统一覆盖点。
 *
 * 这里只映当前会渲染的复制、完成与下载图标。表格全屏已经关闭，因此不再保留进入和退出
 * 全屏所需的 Maximize2Icon 与 XIcon。
 *
 * 每一枚都过一道 asIcon：图标槽收的是组件本身，而图标库的 props 类型不肯收 undefined
 * （见 primitives/icons.ts）。只写在 JSX 里的时候看不出来，当成值交出去的那一刻才现形。
 */
const ICONS: Partial<IconMap> = {
  CheckIcon: asIcon(CheckIcon),
  CopyIcon: asIcon(CopyIcon),
  DownloadIcon: asIcon(DownloadIcon),
}

/*
 * 外链不在这一层拦。
 *
 * linkSafety 默认 { enabled: true }（官方 Configuration 逐字），于是点任何链接都
 * 先弹一个确认框。可这个应用早已在 document 的 capture 阶段接管了全部外链
 * （apps/desktop 的 src/chrome/external-links.ts），链接从来不会在 webview
 * 里导航 —— 弹窗因此不保护任何东西，它只是在系统浏览器已经被唤起之后，多留一个
 * 要人再点一次的框。
 *
 * 一个链接一条路径：点下去，系统浏览器打开它。
 */
const LINK_SAFETY: LinkSafetyConfig = { enabled: false }

export interface ProseProps {
  readonly text: string
  readonly isStreaming: boolean
  /** A place in the timeline, for measure and scale. Never for typography. */
  readonly className?: string
}

/**
 * Markdown from the model, wherever it appears.
 *
 * The answer and the thought chain are the same kind of content — a markdown
 * stream, half written until it is not — so they are rendered by one component
 * rather than by two that drift apart. `timeline-prose` is the single scope the
 * stylesheet dresses, which is why a fenced block inside the thinking already
 * looks like a fenced block inside the answer.
 *
 * 说完了的，就说它说完了。
 *
 * mode 的默认值是 "streaming"（官方 Configuration 逐字），而这里此前从不传它 ——
 * 于是每一段文本都走流式管线，包括早已封口的历史消息，也包括工具卡片里那些一次性
 * 落定的正文。流式管线为「还没写完」准备的三件事因此对它们全部照做一遍：marked 的
 * lexer 把全文 tokenize 成块、每块包一个独立的 memo 组件实例、remend 再扫一遍全文
 * 去补不可能存在的未闭合标记。
 *
 * 这不是常数开销，是按内容长度计费的：转录区虚拟化，一条消息每次重新进入视口就要
 * 重付一次。官方 Usage 的 How Static Mode Works 列的正是这几项，外加代码块走优化过
 * 的静态渲染路径。
 *
 * 正在流的那一行完全不变 —— 那三件事恰恰是它需要的。
 *
 * isAnimating 管的是另一件事：官方对它的定义是「内容是否正在流式（禁用复制按钮）」，
 * 它放行 animate 插件，但不左右解析管线。两个 prop 都要，缺一件都不成立。
 *
 * Line numbers and the download control are turned off through the props that
 * govern them. Overriding rendered output from a stylesheet works until the
 * markup moves; declining to render it does not.
 *
 * A sealed entry is told so as well. Streaming mode exists to survive text that
 * is still arriving — block splitting, repair, a deferred transition — and none
 * of that is work a finished message needs done to it again on every render.
 *
 * 而「不必再做一遍」要成立，得先有人拦住那一次调用。上一版没有：虚拟器同屏
 * 铺着十几行，renderRow 每帧对每个可见行各调用一次，于是十几段早已封口的文本
 * 连同它们的代码高亮、KaTeX 与 mermaid 在每一帧里被重新解析一遍 —— 而其中只有
 * 末尾那一段真的变了。这一层的重渲染不是一次 diff，是一次完整的 markdown 解析，
 * 所以拦住它是正确性预算的一部分，不是一句可选的优化。
 *
 * 三个 prop 全是原始值，默认的浅比较因此就是精确比较：变了的那一行照常重画，
 * 没变的那些一次都不动。
 */
/*
 * 一段 markdown，一处配置。
 *
 * 封口段与在写段此前各写一次 <Streamdown>，八个 prop 在「非流式」这一侧逐字
 * 相同 —— 也就是说封口段本来就是 isStreaming 为假的这一个。两处声明同一件事，
 * 改一处漏一处只是时间问题，而这个文件的每一个常量都恰恰是在讲「一个所有者、
 * 一处配置」。
 *
 * memo 的边界就是一块 markdown：封口之后它的输入再也不变，浅比较因此是精确比较，
 * 这一块此后一帧都不重画。此前边界是「整个封口段」，而封口段是全文前缀 —— 每封口
 * 一块它就换一次字符串，于是前面所有块连同它们的 Shiki 高亮与 KaTeX 一起重新解析
 * 一遍，n 块合计 n(n+1)/2 次。切成块之后每块正好解析一次。
 *
 * 在写的那一块每帧都换字，memo 不命中，也不需要命中。
 *
 * 静态那一侧不切块、不修补、不预留未闭合标记的过渡，代码块走官方那条优化过的
 * 静态路径，也不带 animated：一段早已写完的文字不需要被再写一遍，而逐词的
 * filter 动画是这个界面里唯一会按词数提层的东西。
 */
const ProseSegment = memo(function ProseSegment({
  isStreaming,
  text,
}: {
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
      plugins={PROSE_PLUGINS}
      translations={TRANSLATIONS}
    >
      {text}
    </Streamdown>
  )
})

export const Prose = memo(function Prose({ className, isStreaming, text }: ProseProps) {
  /*
   * 一条流一个切分器。
   *
   * 进度跟着这个组件实例走（useState 的惰性初始化，一个实例只造一次）。它此前是
   * split-stream 里的一个模块级单槽，而屏幕上同时有回答与思考链两条流在长，两者
   * 互不为前缀 —— 谁后调用谁把对方的停点顶掉，续扫因此帧帧不命中。
   */
  const [split] = useState(createBlockScanner)

  /*
   * 切块与流没流无关。
   *
   * 此前这里按 isStreaming 分岔：在写的时候切块，封口之后整篇一块。于是每一轮回答
   * 说完的那一刻，块表从 n 块塌成 1 块 —— key 全变，n 个 ProseSegment 一起卸载、
   * 一个新实例挂载，整篇文本连同它全部的代码高亮、KaTeX 与 mermaid 在这一帧里被
   * 重新解析一次。那正是「回答刚说完界面顿一下」的来处，而它每一轮都发生。思考盒
   * 从来不分岔（ReasoningPanel 恒走切分），所以它没有这一下 —— 正确的做法本来就在
   * 同一个文件里。
   *
   * 一条管线：切点只由文本决定，isStreaming 只决定最后一块要不要走流式渲染。于是
   * 流停下的那一帧块表逐字不变，只有最后一块换一个 prop。
   *
   * 一次线性扫描，没有解析：切点只看行首字符与围栏配平，代价与文本长度成正比而常数
   * 极小，而它省下的是同样与长度成正比、常数大三个量级的一次完整词法分析。
   */
  const blocks = useMemo((): readonly StreamBlock[] => split(text), [split, text])

  return (
    <div
      className={cx('timeline-prose', className)}
      data-streaming={isStreaming ? 'true' : undefined}
    >
      {blocks.map((block, index) => (
        <ProseSegment
          isStreaming={isStreaming && index === blocks.length - 1}
          key={block.key}
          text={block.text}
        />
      ))}
    </div>
  )
})
