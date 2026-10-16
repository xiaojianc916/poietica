import { invariant } from '@poietica/foundation'
import { code as painter } from '@streamdown/code'
import { type CSSProperties, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { CodeBlockCopyButton } from 'streamdown'
import { cachedInks, cachedSvg, currentTheme, keepInks, keepSvg, peekSvg, svgKey } from './diagram-cache'
import { DIAGRAM_CSS, type DiagramInks, diagramInks } from './diagram-theme'
import { CodeIcon, PreviewIcon } from './icons'

/* 自定义渲染器排在上游 mermaid 分支之前，接管 mermaid 围栏；面板样式归 timeline.css。isIncomplete 由上游给（围栏未闭合）：期间屏幕上是源码。 */

type Engine = ReturnType<typeof import('@streamdown/mermaid')['mermaid']['getMermaid']>

type Painted = NonNullable<ReturnType<typeof painter.highlight>>

type Ink = {
  readonly dark: string | undefined
  readonly id: string
  readonly light: string | undefined
  readonly text: string
}

type Row = { readonly id: string; readonly inks: readonly Ink[]; readonly tail: string }

/* theme 取 base：内置主题里唯一把颜色交给 themeVariables 的。securityLevel strict 让标签里的 HTML 不被执行，suppressErrorRendering 让失败不往文档上挂官方错误图。 */
const CONFIG = {
  fontFamily: 'inherit',
  securityLevel: 'strict',
  startOnLoad: false,
  suppressErrorRendering: true,
  theme: 'base',
  themeCSS: DIAGRAM_CSS,
} as const

/* 布局引擎按需取、整个进程共用一台：它在首屏 chunk 里是纯负担。 */
let engine: Promise<Engine> | undefined

function diagramEngine(): Promise<Engine> {
  engine ??= import('@streamdown/mermaid')
    .then((module) => module.mermaid.getMermaid(CONFIG))
    .catch((cause: unknown) => {
      engine = undefined

      invariant(false, `diagram engine unavailable: ${String(cause)}`)
    })

  return engine
}

/* 摘掉引擎写下的 width / height，让宽高回到 CSS 与 viewBox 固有比例（它那对 width:100% + max-width 配不出「一栏宽就铺满、更高就跟着长」）；max-width 保留自然宽，窄图不被拉大。 */
function ground(node: SVGSVGElement): void {
  const box = node.viewBox.baseVal

  /* 没有 viewBox 就没有固有比例：铺满 + auto 算不出高度，原样留着。 */
  if (box.width === 0 || box.height === 0) {
    return
  }

  node.removeAttribute('width')
  node.removeAttribute('height')
  node.style.width = '100%'
  node.style.height = 'auto'
}

/* 走 HTML 解析器而不走 image/svg+xml：标签在 <foreignObject> 里，其中的 <br> 是 void 元素，XML 解析器到它就停下、只交回之前的内容（屏幕上一堆没有节点的箭头和框，且不抛异常）。 */
function parseSvg(svg: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svg, 'text/html')
  const root = parsed.querySelector('svg')

  if (root === null) {
    invariant(false, '引擎交回的不是一份可解析的 SVG')
  }

  return root
}

/* 引擎是模块级单例、配置按进程生效，所以每次画之前都要重新初始化一遍。 */
function useDiagramSvg(code: string, isIncomplete: boolean, inks: DiagramInks | undefined) {
  const seed = useId().replace(/[^a-z0-9]/gi, '')
  const pass = useRef(0)
  /* 首帧就问缓存：这批行被虚拟器卸载过，重挂载先交 undefined 会闪一帧源码面板、行高变两次，虚拟器拿到假尺寸就把
     位置推走；渲染期读缓存必须是纯的，所以 key 与「此刻贴的是哪一格」都留在这份 state 的持有者手里，在 effect 里落定。 */
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

      /* 命中：这一帧就该是图，不再动引擎；初值已经贴上去的那份不重设，免一次无意义的重渲。 */
      if (hit !== undefined) {
        if (shown?.key !== key) {
          setFailure(undefined)
          setShown({ key, svg: parseSvg(hit) })
        }

        return () => {
          live = false
        }
      }

      /* 每画一次换一个 id：引擎按 id 造临时节点，复用会让下一次渲染按 id 找到上一张图；HTML 也要求 id 唯一。 */
      pass.current += 1

      const id = `diagram-${seed}-${pass.current}`

      void diagramEngine()
        .then((instance) => {
          /* 上游 initialize 会把它自己的默认配置摊在最外层，而默认的 theme: 'default' 会顶掉 CONFIG 里的 base，
             所以整份 CONFIG 每次都带上，只递 themeVariables 不够。 */
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

/* 取色探针得挂在真实祖先里才读得到令牌，而祖先要等节点上屏，所以第一帧 inks 是 undefined；探针挂最外层的面板
   而不挂画布：画布内容每次换图都被整片换掉，探针留在那里会被顺手清走。 */
function useInks() {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  /* 首帧就问缓存：没这一份，重挂载后第一帧永远是「没有颜色」，也就永远画不出图（那张图刚被卸载）。 */
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

export const DIAGRAM_RENDERER = { component: Diagram, language: 'mermaid' }
