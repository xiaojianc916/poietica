import { invariant } from '@poietica/foundation'
import { code as painter } from '@streamdown/code'
import { type CSSProperties, type PointerEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { CodeBlockCopyButton } from 'streamdown'

import { CodeIcon, PreviewIcon, ResetIcon, ZoomInIcon, ZoomOutIcon } from '../primitives/icons'

/*
 * 一张图，一块画布。自定义渲染器排在上游自带的 mermaid 分支之前，接管 mermaid 围栏；
 * 面板长什么样归 timeline.css。
 *
 * isIncomplete 由上游给：流式进行中、最后一块、围栏未闭合 —— 官方 Streaming Considerations
 * 一节正是这条路径；未闭合期间屏幕上是源码，闭合当场换成图。
 */

type Engine = ReturnType<typeof import('@streamdown/mermaid')['mermaid']['getMermaid']>

/* 官方高亮插件交回的整份结果。类型从它自己身上取，不为一个类型多引一个包。 */
type Painted = NonNullable<ReturnType<typeof painter.highlight>>

type Size = { readonly height: number; readonly width: number }

/* 视口：图在画布上的位移与倍率。这三个数是「现在看到的是哪一块」的唯一真相。 */
type View = { readonly x: number; readonly y: number; readonly zoom: number }

type Ink = {
  readonly dark: string | undefined
  readonly id: string
  readonly light: string | undefined
  readonly text: string
}

type Row = { readonly id: string; readonly inks: readonly Ink[]; readonly tail: string }

/*
 * 配置只说一次：getMermaid 初始化的是模块级单例，两份配置轮流生效会让同一段源码画出两种
 * 样子。securityLevel strict 让标签里的 HTML 不被执行；suppressErrorRendering 让失败不往
 * 文档上挂官方错误图 —— 失败该说什么由下面的状态决定。
 */
const CONFIG = {
  fontFamily: 'inherit',
  securityLevel: 'strict',
  startOnLoad: false,
  suppressErrorRendering: true,
  theme: 'neutral',
} as const

/*
 * 倍率按等比走不按等差：等比每一档都是 25%，加法步长在两头手感不一。适配不封顶 ——
 * 「适应页面」的含义是恰好铺满，不是「最多原尺寸」。
 */
const ZOOM_MIN = 0.1
const ZOOM_MAX = 4
const ZOOM_RATE = 1.25

/* 适配后四周留出来的空气，让图不贴着框边。 */
const INSET = 16

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

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

/*
 * 打开时的倍率：整张图刚好露出来，宽高各算一次取小的。量不出来（框没尺寸、图没
 * viewBox）交回 undefined 由调用方保持原样，别拿一个 0 把图缩没。
 */
function fitZoom(host: HTMLElement, of: Size): number | undefined {
  if (of.width === 0 || of.height === 0) {
    return undefined
  }

  const across = (host.clientWidth - INSET * 2) / of.width
  const down = (host.clientHeight - INSET * 2) / of.height

  if (!Number.isFinite(across) || !Number.isFinite(down) || across <= 0 || down <= 0) {
    return undefined
  }

  return clampZoom(Math.min(across, down))
}

/*
 * 引擎交回的 svg 自带 width="100%" 与 max-width，在画布上意味着图永远只有一栏宽。viewBox
 * 是图自己的坐标尺寸（viewBox.baseVal 是 SVG DOM 官方读法），按它写死像素才有真实大小；
 * 缩放是外层 transform 的事。
 */
function ground(node: SVGSVGElement): Size {
  const box = node.viewBox.baseVal

  if (box.width === 0 || box.height === 0) {
    return { height: 0, width: 0 }
  }

  node.removeAttribute('width')
  node.removeAttribute('height')
  node.style.maxWidth = 'none'
  node.style.width = `${box.width}px`
  node.style.height = `${box.height}px`

  return { height: box.height, width: box.width }
}

/* 画图这件事本身：一段源码进去，一个 svg 元素或者一句失败原因出来。 */
function useDiagramSvg(code: string, isIncomplete: boolean) {
  const seed = useId().replace(/[^a-z0-9]/gi, '')
  const pass = useRef(0)
  const [graphic, setGraphic] = useState<SVGSVGElement | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    /* 上一张还在画，下一段源码已经到了：迟到的那张不许再贴上去。 */
    let live = true

    if (!isIncomplete) {
      /*
       * 每画一次换一个 id：引擎按 id 造临时节点、画完摘掉，画出的 svg 也带着它 —— id 复用
       * 会让下一次渲染按 id 找到上一张图。HTML 也要求 id 文档内唯一。
       */
      pass.current += 1

      const id = `diagram-${seed}-${pass.current}`

      void diagramEngine()
        .then((instance) => instance.render(id, code))
        .then((drawn) => {
          /*
           * DOMParser 解析失败不抛异常，交回一份装着 parsererror 的文档（官方
           * DOMParser 的 Error handling 一节），所以这里问的是「有没有一个 svg 根」。
           */
          const parsed = new DOMParser().parseFromString(drawn.svg, 'image/svg+xml')
          const root = parsed.querySelector('svg')

          if (root === null) {
            invariant(false, '引擎交回的不是一份可解析的 SVG')
          }

          if (live) {
            setFailure(undefined)
            setGraphic(root)
          }
        })
        .catch((cause: unknown) => {
          if (live) {
            setGraphic(undefined)
            setFailure(cause instanceof Error ? cause.message : String(cause))
          }
        })
    }

    return () => {
      live = false
    }
  }, [code, isIncomplete, seed])

  return { failure, graphic }
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
 * Ctrl/⌘+滚轮缩放。只能自己挂监听：React 把 wheel 等一律注册成被动监听器，被动监听里
 * preventDefault 无效，浏览器照样缩放整页。不带修饰键的滚轮一概不接 —— 面板长在会话流里，
 * 不能让读者在图上划不动页面（上游 pan-zoom 无条件 preventDefault，这条不抄）。
 */
function useWheelZoom(
  stage: React.RefObject<HTMLDivElement | null>,
  zoomAt: (rate: number, at: { x: number; y: number }) => void,
) {
  useEffect(() => {
    const host = stage.current

    if (host === null) {
      return
    }

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return
      }

      event.preventDefault()

      const box = host.getBoundingClientRect()

      zoomAt(event.deltaY < 0 ? ZOOM_RATE : 1 / ZOOM_RATE, {
        x: event.clientX - box.left - box.width / 2,
        y: event.clientY - box.top - box.height / 2,
      })
    }

    host.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      host.removeEventListener('wheel', onWheel)
    }
  }, [stage, zoomAt])
}

/*
 * 画布的视口。不用滚动容器（只两条轴、拖到头就停、图上压两根灰杠）：位移与倍率合成一条
 * transform，按住往哪都能拖 —— 专业绘图工具一律是这个模型。
 */
function useCanvas(graphic: SVGSVGElement | undefined) {
  const stage = useRef<HTMLDivElement | null>(null)
  const natural = useRef<Size>({ height: 0, width: 0 })
  const grip = useRef<{ x: number; y: number } | null>(null)
  /* 用户还没动过手 —— 只有这种时候，框的尺寸一变才允许替他重新适配。 */
  const untouched = useRef(true)
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 })

  /*
   * 回到「适应页面」：位移归零（画布中心对准舞台中心，靠 transform 第一段居中，任何倍率
   * 都成立），倍率取刚好装得下的那一档。
   */
  const home = useCallback(() => {
    const host = stage.current

    if (host === null) {
      return
    }

    const zoom = fitZoom(host, natural.current)

    if (zoom === undefined) {
      return
    }

    untouched.current = true
    setView({ x: 0, y: 0, zoom })
  }, [])

  /* at 是指针相对框中心的位置：缩放前后让它底下那个点原地不动即「以指针为锚」；不给 at 就围绕视野中心（按钮）。 */
  const zoomAt = useCallback((rate: number, at?: { x: number; y: number }) => {
    untouched.current = false
    setView((last) => {
      const zoom = clampZoom(last.zoom * rate)

      if (at === undefined) {
        return { ...last, zoom }
      }

      const ratio = zoom / last.zoom

      return { x: at.x - (at.x - last.x) * ratio, y: at.y - (at.y - last.y) * ratio, zoom }
    })
  }, [])

  /*
   * 上屏走 ref 回调不走 effect：effect 只在依赖变化时跑，而节点是否已挂载与依赖无关；ref
   * 回调在挂载那一刻调用，数据与节点谁先到都成立。这片 DOM 归回调独有，不放 React 子节点。
   */
  const mount = useCallback(
    (host: HTMLDivElement | null) => {
      if (host === null || graphic === undefined) {
        return
      }

      const node = host.ownerDocument.importNode(graphic, true)

      natural.current = ground(node)
      host.replaceChildren(node)

      /*
       * 换图就在这里重新适配，不绕 effect：graphic 是 hook 入参，当依赖会被 biome 的
       * useExhaustiveDependencies 判为外层作用域变量，删掉依赖则换图后无物触发适配。
       * 尺寸是上一行 ground() 刚量出的，节点上屏与按新尺寸铺满是同一件事。
       */
      home()
    },
    [graphic, home],
  )

  /*
   * 框的尺寸不是一开始就知道（源码视图下 display:none 量出零，切回才有真实值）。
   * ResizeObserver 开始观察时先报一次当前尺寸，首屏适配一并兜住。
   */
  useEffect(() => {
    const host = stage.current

    if (host === null) {
      return
    }

    const watch = new ResizeObserver(() => {
      if (untouched.current) {
        home()
      }
    })

    watch.observe(host)

    return () => {
      watch.disconnect()
    }
  }, [home])

  useWheelZoom(stage, zoomAt)

  /* 按住拖。setPointerCapture 后指针滑出面板、窗口都还算数，松手才结束（指针事件规范的能力）。 */
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    grip.current = { x: event.clientX, y: event.clientY }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const last = grip.current

    if (last === null) {
      return
    }

    const dx = event.clientX - last.x
    const dy = event.clientY - last.y

    grip.current = { x: event.clientX, y: event.clientY }
    untouched.current = false
    setView((now) => ({ ...now, x: now.x + dx, y: now.y + dy }))
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (grip.current === null) {
      return
    }

    event.currentTarget.releasePointerCapture(event.pointerId)
    grip.current = null
  }

  return { home, mount, onPointerDown, onPointerMove, onPointerUp, stage, view, zoomAt }
}

export interface DiagramProps {
  readonly code: string
  readonly isIncomplete: boolean
}

export function Diagram({ code, isIncomplete }: DiagramProps) {
  const { failure, graphic } = useDiagramSvg(code, isIncomplete)
  const canvas = useCanvas(graphic)
  const [asCode, setAsCode] = useState(false)
  const showCode = asCode || graphic === undefined
  const Toggle = showCode ? PreviewIcon : CodeIcon
  const toggle = showCode ? '看图' : '看源码'
  const { x, y, zoom } = canvas.view

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
        {!showCode && (
          <>
            <span className="timeline-prose__diagram-split" />
            <button
              aria-label="缩小"
              className="timeline-prose__diagram-tool"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => {
                canvas.zoomAt(1 / ZOOM_RATE)
              }}
              type="button"
            >
              <ZoomOutIcon aria-hidden="true" />
            </button>
            <button
              aria-label="放大"
              className="timeline-prose__diagram-tool"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => {
                canvas.zoomAt(ZOOM_RATE)
              }}
              type="button"
            >
              <ZoomInIcon aria-hidden="true" />
            </button>
            <button aria-label="适应页面" className="timeline-prose__diagram-tool" onClick={canvas.home} type="button">
              <ResetIcon aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {failure !== undefined && <p className="timeline-prose__diagram-alert">这段 mermaid 没能画出来：{failure}</p>}
      <div
        className="timeline-prose__diagram-stage"
        onPointerCancel={canvas.onPointerUp}
        onPointerDown={canvas.onPointerDown}
        onPointerMove={canvas.onPointerMove}
        onPointerUp={canvas.onPointerUp}
        ref={canvas.stage}
      >
        <div
          className="timeline-prose__diagram-canvas"
          ref={canvas.mount}
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${zoom})` }}
        />
      </div>
      {showCode && <Source source={code} />}
    </div>
  )
}

/* 注册进 Streamdown 的 renderers：mermaid 围栏从此只走这一条路径。 */
export const DIAGRAM_RENDERER = { component: Diagram, language: 'mermaid' }
