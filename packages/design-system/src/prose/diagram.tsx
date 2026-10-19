import { invariant } from '@poietica/foundation'
import { code as painter } from '@streamdown/code'
import { type RenderResult, render } from 'pele'
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react'
import { CodeBlockCopyButton } from 'streamdown'
import { keepSvg, peekSvg, svgKey } from './diagram-cache'
import { CodeIcon, PreviewIcon } from './icons'

/* 自定义渲染器排在上游的 mermaid 分支之前，接管 mermaid 围栏；面板样式归 prose.css。
   isIncomplete 由上游给（围栏未闭合）：期间屏幕上是源码 —— pele 对半截源码一律抛 syntax，逐字重画只会闪错误。 */

type Painted = NonNullable<ReturnType<typeof painter.highlight>>

/* pele 同步渲染、没有全局实例：拿到源码就能立刻算出一张 svg 字符串，不存在「上一张还没画完」的竞态。
   代价是它比 mermaid 快得多但仍是主线程工作，所以整张 svg 按源码字符串缓存。 */
/* 交给引擎的只有源码。颜色一个都不进渲染：pele 的 svg 里写的是 var(--pele-*)，由 CSS 在下面按设计令牌赋值，
   于是换主题是纯样式的事 —— 不重跑布局，也不会有「换主题那一帧先闪一张旧配色的图」。 */
const RENDER_OPTIONS = {
  /* 链接只留成可点的 <a>，且这只影响 <a> 的生成；图里本来就不该有可以自己跑起来的东西。 */
  links: true,
  images: false,
  /* 图标不解析：默认解析器会去够远端，而正文里不该有这张图自己发起的请求。 */
  icons: () => null,
} as const

/* svg 原样上屏，**不在这里改尺寸**。pele 按紧凑尺寸排版（三节点流程图约 160×64），铺满栏宽会连字号一起放大；
   而 CSS 里又不能什么都不写 —— :where(svg) 会把所有 svg 默认压成图标大小。所以尺寸与只缩不放的规则统一放在
   prose.css 的 .timeline-prose__diagram-stage svg 里，这里只管把节点挂上去。 */

/* 走 HTML 解析器而不走 image/svg+xml：pele 的标签里可能有 <br> 之类的 void 元素，XML 解析器到它就停下、
   只交回之前的内容（屏幕上一堆没有节点的箭头和框，且不抛异常）。 */
function parseSvg(svg: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svg, 'text/html')
  const root = parsed.querySelector('svg')

  if (root === null) {
    invariant(false, '引擎交回的不是一份可解析的 SVG')
  }

  return root
}

/* 一张画好的图，或者「为什么画不出来」。判别字段显式写出来：只靠 `'svg' in drawn` 收窄不了同级的 key。 */
type Drawn =
  | { readonly kind: 'svg'; readonly code: string; readonly svg: string }
  | { readonly kind: 'failure'; readonly failure: string }

/* 画一张。pele 的 PeleError 带 code / line，正文里只留一句人话。 */
function draw(code: string): Drawn {
  let drawn: RenderResult

  try {
    drawn = render(code, RENDER_OPTIONS)
  } catch (cause: unknown) {
    return { kind: 'failure', failure: cause instanceof Error ? cause.message : String(cause) }
  }

  return { code, kind: 'svg', svg: drawn.svg }
}

/* 渲染期就把图画出来，不放到 effect 里。
   同步引擎允许这件事，而它正好治掉一个老毛病：虚拟器按行高定位，图晚一帧上屏就是「先源码面板、再变成图」，
   量到两次高度、位置跟着跳。代价是这张图在 render 里算，所以只认源码 —— 换了主题不该重算（颜色是 CSS 引用）。 */
function useDiagramSvg(
  code: string,
  isIncomplete: boolean,
): { readonly failure: string | undefined; readonly graphic: SVGSVGElement | undefined } {
  const drawn = useMemo(() => {
    if (isIncomplete) {
      return undefined
    }

    const hit = peekSvg(svgKey(code))

    return hit === undefined ? draw(code) : { code, kind: 'svg' as const, svg: hit }
  }, [code, isIncomplete])

  /* 缓存是副作用，只在这里写：渲染期只能读（React 可能把同一次渲染跑两遍）。 */
  useEffect(() => {
    if (drawn?.kind === 'svg') {
      keepSvg(svgKey(drawn.code), drawn.svg)
    }
  }, [drawn])

  const graphic = useMemo(() => (drawn?.kind === 'svg' ? parseSvg(drawn.svg) : undefined), [drawn])

  return { failure: drawn?.kind === 'failure' ? drawn.failure : undefined, graphic }
}

/* 双主题里暗色那一档写在 token 的 htmlStyle 上；形状不对就当没有。 */
function darkInk(style: unknown): string | undefined {
  if (typeof style !== 'object' || style === null) {
    return undefined
  }

  const found = (style as Record<string, unknown>)['--shiki-dark']

  return typeof found === 'string' ? found : undefined
}

/* tm-grammars 的 mermaid 是一份 Markdown 注入语法，顶层只有 :::mermaid 容器规则：喂裸源码或反引号围栏都匹配不上，
   整段退化成单色 token；所以前后各补一行 ::: 拿回 token，再把这两行摘掉。 */
const FENCE = ':::'

function fence(source: string): string {
  return `${FENCE}mermaid\n${source}\n${FENCE}`
}

/* 摘掉前后两行围栏；行数对不上就当没上色，不冒吃掉一行正文的险。 */
function unfence(painted: Painted, lines: number): Painted['tokens'] | undefined {
  if (painted.tokens.length === lines + 2) {
    return painted.tokens.slice(1, -1)
  }

  return painted.tokens.length === lines ? painted.tokens : undefined
}

/* 官方代码块组件带着整只壳，这里只要 Shiki 的分词与复制按钮；highlight 首次一律返回 null，结果经回调异步到达。 */
function useSource(source: string): readonly Row[] | undefined {
  const [painted, setPainted] = useState<Painted | undefined>(undefined)

  useEffect(() => {
    let live = true

    const ready = painter.highlight(
      { code: fence(source), language: 'mermaid', themes: painter.getThemes() },
      (result) => {
        if (live) {
          setPainted(result)
        }
      },
    )

    setPainted(ready ?? undefined)

    return () => {
      live = false
    }
  }, [source])

  return useMemo(() => {
    if (painted === undefined) {
      return undefined
    }

    const body = unfence(painted, source.split('\n').length)

    if (body === undefined) {
      return undefined
    }

    const last = body.length - 1

    return body.map((line, index) => ({
      id: `row-${index}`,
      inks: line.map((token, spot) => ({
        dark: darkInk(token.htmlStyle),
        id: `ink-${index}-${spot}`,
        light: token.color,
        text: token.content,
      })),
      /* 换行由文本自己带，不靠 display: block —— 空行才有高度；末行不带，免得多出一行。 */
      tail: index === last ? '' : '\n',
    }))
  }, [painted, source])
}

type Ink = {
  readonly dark: string | undefined
  readonly id: string
  readonly light: string | undefined
  readonly text: string
}

type Row = { readonly id: string; readonly inks: readonly Ink[]; readonly tail: string }

function Source({ source }: { readonly source: string }) {
  const rows = useSource(source)

  return (
    <pre className="timeline-prose__diagram-source">
      <code>
        {rows === undefined
          ? source
          : rows.map((row) => (
              <span key={row.id}>
                {row.inks.map((ink) => (
                  <span
                    className="timeline-prose__diagram-ink"
                    key={ink.id}
                    style={{ '--cp-tok': ink.light, '--cp-tok-dark': ink.dark } as CSSProperties}
                  >
                    {ink.text}
                  </span>
                ))}
                {row.tail}
              </span>
            ))}
      </code>
    </pre>
  )
}

/* 上屏走 ref 回调不走 effect（节点是否已挂载与依赖无关）；画布不做缩放/位移/拖拽，宽度按栏宽、高度随比例。 */
function useGraphic(graphic: SVGSVGElement | undefined) {
  return useCallback(
    (host: HTMLDivElement | null) => {
      if (host === null || graphic === undefined) {
        return
      }

      host.replaceChildren(host.ownerDocument.importNode(graphic, true))
    },
    [graphic],
  )
}

export interface DiagramProps {
  readonly code: string
  readonly isIncomplete: boolean
}

export function Diagram({ code, isIncomplete }: DiagramProps) {
  const { failure, graphic } = useDiagramSvg(code, isIncomplete)
  const mount = useGraphic(graphic)
  const [asCode, setAsCode] = useState(false)
  const showCode = asCode || graphic === undefined
  const Toggle = showCode ? PreviewIcon : CodeIcon
  const toggle = showCode ? '看图' : '看源码'

  return (
    <div className="timeline-prose__diagram" data-view={showCode ? 'code' : 'diagram'}>
      <div className="timeline-prose__diagram-tools">
        <CodeBlockCopyButton className="timeline-prose__diagram-tool" code={code} />
        <button
          aria-label={toggle}
          className="timeline-prose__diagram-tool"
          disabled={graphic === undefined}
          onClick={() => {
            setAsCode(!asCode)
          }}
          type="button"
        >
          <Toggle aria-hidden="true" />
        </button>
      </div>
      {failure !== undefined && <p className="timeline-prose__diagram-alert">这段 mermaid 没能画出来：{failure}</p>}
      <div className="timeline-prose__diagram-stage" ref={mount} />
      {showCode && <Source source={code} />}
    </div>
  )
}

export const DIAGRAM_RENDERER = { component: Diagram, language: 'mermaid' }
