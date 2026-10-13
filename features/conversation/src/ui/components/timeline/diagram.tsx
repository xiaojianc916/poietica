import { invariant } from '@poietica/foundation'
import { code as painter } from '@streamdown/code'
import { type CSSProperties, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { CodeBlockCopyButton } from 'streamdown'

import { CodeIcon, PreviewIcon } from '../primitives/icons'
import { cachedInks, cachedSvg, currentTheme, keepInks, keepSvg, peekSvg, svgKey } from './diagram-cache'
import { DIAGRAM_CSS, type DiagramInks, diagramInks } from './diagram-theme'

/*
 * 一张图，直接长在正文里。自定义渲染器排在上游自带的 mermaid 分支之前，接管 mermaid 围栏；
 * 面板长什么样归 timeline.css。
 *
 * isIncomplete 由上游给：流式进行中、最后一块、围栏未闭合 —— 官方 Streaming Considerations
 * 一节正是这条路径；未闭合期间屏幕上是源码，闭合当场换成图。
 */

type Engine = ReturnType<typeof import('@streamdown/mermaid')['mermaid']['getMermaid']>

/* 官方高亮插件交回的整份结果。类型从它自己身上取，不为一个类型多引一个包。 */
type Painted = NonNullable<ReturnType<typeof painter.highlight>>

type Ink = {
  readonly dark: string | undefined
  readonly id: string
  readonly light: string | undefined
  readonly text: string
}

type Row = { readonly id: string; readonly inks: readonly Ink[]; readonly tail: string }

/*
 * 主题走 base：它是五个内置主题里唯一把每个部位的颜色交给 themeVariables 的（default /
 * neutral / dark / forest 的配色写死在主题里）。颜色由 diagram-theme.ts 从设计令牌解析，
 * 深浅两套主题共用同一份配置 —— 换主题时重新解析、重画。
 *
 * themeCSS 是另一条出口，只给 mindmap 用：它的分支配色压的是图自己那份样式表（为什么
 * 不能走 themeVariables，见 diagram-theme.ts 的头注）。
 *
 * securityLevel strict 让标签里的 HTML 不被执行；suppressErrorRendering 让失败不往文档上
 * 挂官方错误图 —— 失败该说什么由下面的状态决定。
 */
const CONFIG = {
  fontFamily: 'inherit',
  securityLevel: 'strict',
  startOnLoad: false,
  suppressErrorRendering: true,
  theme: 'base',
  themeCSS: DIAGRAM_CSS,
} as const

/* 布局引擎按需取，取回来整个进程共用一台：它在首屏 chunk 里是纯负担。 */
let engine: Promise<Engine> | undefined

function diagramEngine(): Promise<Engine> {
  engine ??= import('@streamdown/mermaid')
    .then((module) => module.mermaid.getMermaid(CONFIG))
    .catch((cause: unknown) => {
      /* 取不回来不是此后的定局：忘掉这一次，下一张图重新取。 */
      engine = undefined

      invariant(false, `diagram engine unavailable: ${String(cause)}`)
    })

  return engine
}

/*
 * 尺寸只按宽度算，高度随比例。
 *
 * 引擎写下的 width="100%" 与 style="max-width: Npx" 说的是「最多长到自然宽」，配不出
 * 「一栏宽就铺满、更高就跟着长」；所以把它自己的 width / height 属性摘掉，让宽高回到
 * CSS 与 viewBox 固有比例。max-width 保留自然宽：窄图不被拉大，宽图缩到一栏。
 */
function ground(node: SVGSVGElement): void {
  const box = node.viewBox.baseVal

  /* 没有 viewBox 就没有固有比例，宽度铺满、高度 auto 会算不出高度 —— 原样留着。 */
  if (box.width === 0 || box.height === 0) {
    return
  }

  node.removeAttribute('width')
  node.removeAttribute('height')
  node.style.width = '100%'
  node.style.height = 'auto'
}

/*
 * 引擎交回的字符串 → 一个可挂的 svg 元素。
 *
 * 走 HTML 解析器，不走 `image/svg+xml`：mermaid 把标签写在 <foreignObject> 里，
 * 标签里的 `<br>` 是 HTML 的 void 元素（没有自闭合斜杠）。XML 解析器到第一个 `<br>`
 * 就停下，交回的文档只有它之前的内容 —— 而引擎的输出顺序是 cluster → 连线 →
 * 分支标签 → 节点，于是屏幕上正好剩下一堆没有节点的箭头和框（节点面、节点文字全丢，
 * 分支标签只有不跨行的那些活下来），而且 DOMParser 不抛异常，parseSvg 看不出错。
 *
 * HTML 解析器按 HTML 的规则收下这些标签，foreignObject 内外的命名空间不变，`<style>`
 * 里的选择器也照常生效。仍然要问一句「有没有一个 svg 根」：真失败时交回的是解析错误页
 * 而不是异常。
 */
function parseSvg(svg: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svg, 'text/html')
  const root = parsed.querySelector('svg')

  if (root === null) {
    invariant(false, '引擎交回的不是一份可解析的 SVG')
  }

  return root
}

/*
 * 画图这件事本身：一段源码进去，一个 svg 元素或者一句失败原因出来。
 *
 * inks 是画这一张要用的那套颜色。引擎是模块级单例、配置按进程生效，所以每次画之前把
 * 颜色重新初始化一遍 —— 主题换了、或者同一进程里前后两张图所属的主题不同，画出来才会
 * 跟着变。
 */
function useDiagramSvg(code: string, isIncomplete: boolean, inks: DiagramInks | undefined) {
  const seed = useId().replace(/[^a-z0-9]/gi, '')
  const pass = useRef(0)
  /*
   * 首帧就问缓存：这批行原本被虚拟器卸载过，重挂载时如果先交 undefined，屏幕上会闪一帧
   * 源码面板，行高跟着变两次（源码高 → 图高），虚拟器收到假尺寸就把位置推走。
   *
   * 键跟着节点走而不是另记一份：渲染期读缓存必须是纯的（它会被重播、被丢弃），
   * 使用顺序与「此刻贴的是哪一格」都归这份 state 的持有者，在 effect 里落定。
   */
  const [shown, setShown] = useState<{ readonly key: string; readonly svg: SVGSVGElement } | undefined>(() => {
    if (isIncomplete || inks === undefined) {
      return undefined
    }

    const key = svgKey(inks, code)
    const hit = peekSvg(key)

    return hit === undefined ? undefined : { key, svg: parseSvg(hit) }
  })
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    /* 上一张还在画，下一段源码已经到了：迟到的那张不许再贴上去。 */
    let live = true

    if (!isIncomplete && inks !== undefined) {
      const key = svgKey(inks, code)
      const hit = cachedSvg(key)

      /*
       * 命中：这一帧就该是图，不再动引擎。初值已经贴上去的那一份不重设，免一次
       * 无意义的重渲。
       */
      if (hit !== undefined) {
        if (shown?.key !== key) {
          setFailure(undefined)
          setShown({ key, svg: parseSvg(hit) })
        }

        return () => {
          live = false
        }
      }

      /*
       * 每画一次换一个 id：引擎按 id 造临时节点、画完摘掉，画出的 svg 也带着它 —— id 复用
       * 会让下一次渲染按 id 找到上一张图。HTML 也要求 id 文档内唯一。
       */
      pass.current += 1

      const id = `diagram-${seed}-${pass.current}`

      void diagramEngine()
        .then((instance) => {
          /*
           * 上游的 initialize 会把它自己的默认配置重新摊在最外层（`{...默认, ...插件配置, ...这一份}`），
           * 而它默认是 theme: 'default' —— 只递 themeVariables 的话，上面 CONFIG 里的
           * theme: 'base' 会被顶掉，画出来又是 default 那套写死的紫。所以整份 CONFIG 每次都带上。
           */
          instance.initialize({ ...CONFIG, themeVariables: inks })

          return instance.render(id, code)
        })
        .then((drawn) => {
          const root = parseSvg(drawn.svg)

          if (live) {
            keepSvg(key, drawn.svg)
            setFailure(undefined)
            setShown({ key, svg: root })
          }
        })
        .catch((cause: unknown) => {
          if (live) {
            setShown(undefined)
            setFailure(cause instanceof Error ? cause.message : String(cause))
          }
        })
    }

    return () => {
      live = false
    }
  }, [code, inks, isIncomplete, seed, shown])

  return { failure, graphic: shown?.svg }
}

/* 双主题里暗色那一档写在 token 的 htmlStyle 上。这里只认字符串，形状不对就当没有。 */
function darkInk(style: unknown): string | undefined {
  if (typeof style !== 'object' || style === null) {
    return undefined
  }

  const found = (style as Record<string, unknown>)['--shiki-dark']

  return typeof found === 'string' ? found : undefined
}

/*
 * tm-grammars 的 mermaid 是一份 Markdown 注入语法：injectionSelector 为 L:text.html.markdown，
 * 顶层只有 :::mermaid 容器规则（begin 为 (?i)\s*:::\s*mermaid\s*$，闭合 \s*:::\s*；是容器
 * 指令的三个冒号，不是反引号）。喂裸源码或反引号围栏，顶层一条也匹配不上，整段退化成默认
 * 前景色 token —— 「高亮引擎在跑、屏幕上却一片单色」的成因，与用不用官方代码块组件无关。
 * 所以前后各补一行 ::: 拿回 token 再把这两行摘掉，补的是这份语法写明要求的上下文。
 */
const FENCE = ':::'

function fence(source: string): string {
  return `${FENCE}mermaid\n${source}\n${FENCE}`
}

/* 摘掉前后两行围栏。行数对不上就当没上色，绝不冒吃掉一行正文的险。 */
function unfence(painted: Painted, lines: number): Painted['tokens'] | undefined {
  if (painted.tokens.length === lines + 2) {
    return painted.tokens.slice(1, -1)
  }

  return painted.tokens.length === lines ? painted.tokens : undefined
}

/*
 * 源码归这块面板自己上色：官方代码块组件带着整只壳，这里只要 Shiki 的分词与复制按钮。
 * 分词由官方插件的 highlight 给（与正文围栏共用同一插件实例与 token 缓存）。highlight
 * 首次一律返回 null，结果经回调异步到达 —— 那几帧是未上色的纯文本。
 */
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
      /* 换行由文本自己带，不靠 display: block —— 空行才有高度。末行不带，免得多出一行。 */
      tail: index === last ? '' : '\n',
    }))
  }, [painted, source])
}

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

/*
 * 上屏走 ref 回调不走 effect：effect 只在依赖变化时跑，而节点是否已挂载与依赖无关；ref
 * 回调在挂载那一刻调用，数据与节点谁先到都成立。这片 DOM 归回调独有，不放 React 子节点。
 *
 * 图不做画布：没有缩放、没有位移、没有拖拽。宽度按栏宽适配、高度随比例，框一变浏览器
 * 自己重排，这里没有需要重算的状态，也就没有要监听的东西。
 */
function useGraphic(graphic: SVGSVGElement | undefined) {
  return useCallback(
    (host: HTMLDivElement | null) => {
      if (host === null || graphic === undefined) {
        return
      }

      const node = host.ownerDocument.importNode(graphic, true)

      ground(node)
      host.replaceChildren(node)
    },
    [graphic],
  )
}

export interface DiagramProps {
  readonly code: string
  readonly isIncomplete: boolean
}

/*
 * 画这张图要用的颜色，跟着 data-theme 走。
 *
 * 取色的探针得挂在真实的祖先里才读得到令牌，而祖先要等节点上屏 —— 所以这段解析不能放在
 * 渲染期。第一帧 inks 还是 undefined，useDiagramSvg 不动；拿到节点、读到颜色之后补上。
 *
 * 探针挂在最外层的面板上，不挂画布：画布的内容每次换图都被整片换掉，探针留在那里会被
 * 顺手清走。
 */
function useInks() {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  /*
   * 首帧就问缓存：取色探针要挂在真实祖先里才读得到令牌，而祖先要等节点上屏 ——
   * 没这一份，重挂载后第一帧永远是「没有颜色」，也就永远画不出图（那张图刚被卸载）。
   */
  const [inks, setInks] = useState<DiagramInks | undefined>(() => cachedInks(currentTheme()))
  const attach = useCallback((node: HTMLDivElement | null) => {
    setHost(node)
  }, [])

  useEffect(() => {
    if (host === null) {
      return
    }

    const read = () => {
      const next = diagramInks(host)

      keepInks(currentTheme(), next)
      setInks(next)
    }

    read()

    /* 换主题只换属性：观察它比轮询样式表省事，也不必猜是谁改的。 */
    const watch = new MutationObserver(read)

    watch.observe(document.documentElement, { attributeFilter: ['data-theme'], attributes: true })

    return () => {
      watch.disconnect()
    }
  }, [host])

  return { attach, inks }
}

export function Diagram({ code, isIncomplete }: DiagramProps) {
  const { attach, inks } = useInks()
  const { failure, graphic } = useDiagramSvg(code, isIncomplete, inks)
  const mount = useGraphic(graphic)
  const [asCode, setAsCode] = useState(false)
  const showCode = asCode || graphic === undefined
  const Toggle = showCode ? PreviewIcon : CodeIcon
  const toggle = showCode ? '看图' : '看源码'

  return (
    <div className="timeline-prose__diagram" data-view={showCode ? 'code' : 'diagram'} ref={attach}>
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

/* 注册进 Streamdown 的 renderers：mermaid 围栏从此只走这一条路径。 */
export const DIAGRAM_RENDERER = { component: Diagram, language: 'mermaid' }
