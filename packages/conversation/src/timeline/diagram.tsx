import { code as painter } from '@streamdown/code'
import {
  type CSSProperties,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { CodeBlockCopyButton } from 'streamdown'

import { CodeIcon, PreviewIcon, ResetIcon, ZoomInIcon, ZoomOutIcon } from '../primitives/icons'

/*
 * 一张图，一块画布。
 *
 * mermaid 围栏由这里接管：自定义渲染器排在上游自带的 mermaid 分支之前，那套「外层卡片 +
 * 语言标签 + 悬在渲染区上方的按钮 + 内层卡片」因此没有机会出现。面板长什么样归 timeline.css。
 *
 * isIncomplete 由上游给：流式进行中、且这是最后一块、且围栏尚未闭合 —— 官方 Streaming
 * Considerations 一节给的正是这条路径。围栏没闭合的这段时间屏幕上是源码，闭合当场换成图。
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
 * 引擎的配置只说一次：getMermaid 初始化的是模块级单例，两份配置轮流生效意味着同一段源码
 * 画出两种样子。
 *
 * theme neutral 是灰阶，与这块面板同一个语气；fontFamily 交给 inherit，图里的中文标签因此
 * 和界面同一套字形。securityLevel strict 让标签里的 HTML 不被执行，suppressErrorRendering
 * 让渲染失败不要往文档上挂一张官方错误图 —— 失败该说什么，由下面那个状态决定。
 */
const CONFIG = {
  fontFamily: 'inherit',
  securityLevel: 'strict',
  startOnLoad: false,
  suppressErrorRendering: true,
  theme: 'neutral',
} as const

/*
 * 倍率按等比走，不按等差：加法步长在两头的手感是两回事，等比每一档都是 25%。
 *
 * 下限压到 0.1，且适配那一步不封顶 —— 一张巨图要缩到 0.3 才看得全，一张小图放到 2 倍才填得
 * 满这块 26rem 的画布。「适应页面」的含义就是恰好铺满，不是「最多原尺寸」。
 */
const ZOOM_MIN = 0.1
const ZOOM_MAX = 4
const ZOOM_RATE = 1.25

/* 适配后四周留出来的空气，让图不贴着框边。 */
const INSET = 16

/*
 * 布局引擎按需取，取回来的整个进程共用一台：它在首屏那个 chunk 里是纯负担。动态 import 是
 * ESM 与打包器官方的代码分割形态。
 */
let engine: Promise<Engine> | undefined

function diagramEngine(): Promise<Engine> {
  engine ??= import('@streamdown/mermaid')
    .then((module) => module.mermaid.getMermaid(CONFIG))
    .catch((cause: unknown) => {
      /* 取不回来不是此后的定局：忘掉这一次，下一张图重新取。 */
      engine = undefined

      throw new Error(`diagram engine unavailable: ${String(cause)}`)
    })

  return engine
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

/*
 * 打开时该有的倍率：整张图刚好露出来。
 *
 * 宽高两个方向各算一次，取小的那个 —— 小的那个才是两个方向都装得下的。量不出来（框还没有
 * 尺寸、图没有 viewBox）就交回 undefined，由调用方保持原样，别拿一个 0 把图缩没。
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
 * 引擎交出来的 svg 自带 width="100%" 与一条 max-width：那是给「跟着栏宽走」用的，在画布上
 * 它意味着图永远只有一栏宽。viewBox 是这张图自己的坐标尺寸（viewBox.baseVal 是 SVG DOM 的
 * 官方读法），按它写死像素，图才有真实大小；缩放是外面那层 transform 的事，与它无关。
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
       * 每画一次换一个 id。引擎拿它造一个临时节点、画完再按 id 把它摘掉，而画出来的那个
       * svg 自己也带着这个 id 一起交回来 —— id 复用意味着下一次渲染按 id 找到的是上一张
       * 图。上游同样每次现编一个，HTML 也要求 id 文档内唯一。
       */
      pass.current += 1

      const id = `diagram-${seed}-${pass.current}`

      void diagramEngine()
        .then((instance) => instance.render(id, code))
        .then((drawn) => {
          /*
           * 解析失败时 DOMParser 不抛异常，它交回一份装着 parsererror 的文档（官方
           * DOMParser 的 Error handling 一节），所以这里问的是「有没有一个 svg 根」。
           */
          const parsed = new DOMParser().parseFromString(drawn.svg, 'image/svg+xml')
          const root = parsed.querySelector('svg')

          if (root === null) {
            throw new Error('引擎交回的不是一份可解析的 SVG')
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
 * 围栏是这份语法的入口，不是装饰。
 *
 * tm-grammars 里的 mermaid 是一份 Markdown 注入语法：injectionSelector 写着
 * L:text.html.markdown、fileTypes 是空的，顶层 patterns 只有 mermaid-code-block 与
 * mermaid-code-block-with-attributes 两条围栏规则。裸源码喂进去，顶层一条也匹配不上，每行
 * 退化成一个默认前景色的 token —— 「高亮引擎在跑、屏幕上却一片单色」的成因就在这里，与用不
 * 用官方代码块组件无关。
 *
 * 入口写死在它的 begin 里：(?i)\s*:::\s*mermaid\s*$，闭合是 \s*:::\s*。是 Markdown 容器
 * 指令的三个冒号，不是三个反引号 —— 规则名里的 code-block 说的是容器块。喂反引号顶层一条
 * 也匹配不上，于是整段退化成默认前景色的 token，屏幕上就是一片单色。
 *
 * 所以前后各补一行 :::，拿回 token 再把这两行摘掉。补的是这份语法写明要求的上下文，不是
 * 自己写一个分词器。
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
 * 源码也归这块面板自己上色。
 *
 * 官方代码块组件带着一整只壳：外框、圆角、语言标签栏；这块面板要的是与渲染区同一块纯色，
 * 只取它的两样东西：Shiki 的分词，和复制按钮。分词由官方插件的
 * highlight 直接给（与正文里那些围栏共用同一个插件实例、同一份 token 缓存），复制按钮照旧
 * 用官方那一枚。
 *
 * highlight 首次一律返回 null，结果经回调异步到达 —— 那几帧显示的是未上色的纯文本。
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
 * Ctrl / ⌘ + 滚轮缩放。
 *
 * 只能自己挂监听：React 把 wheel、touchstart、touchmove 一律注册成被动监听器，被动监听里
 * preventDefault 无效，浏览器会照样去缩放整个页面。
 *
 * 不带修饰键的滚轮一概不接 —— 这块面板长在一条会话流里，把滚轮据为己有等于让读者在图上划不
 * 动页面。上游那个 pan-zoom 组件无条件 preventDefault，这一条不抄。
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
 * 画布的视口。
 *
 * 不用滚动容器：滚动只能沿两条轴走、拖到头就停、还要在图上压两根灰杠。这里是一张摊开的
 * 画布 —— 按住往哪都能拖，位移与倍率合起来是一条 transform。专业绘图工具一律是这个模型。
 */
function useCanvas(graphic: SVGSVGElement | undefined) {
  const stage = useRef<HTMLDivElement | null>(null)
  const natural = useRef<Size>({ height: 0, width: 0 })
  const grip = useRef<{ x: number; y: number } | null>(null)
  /* 用户还没动过手 —— 只有这种时候，框的尺寸一变才允许替他重新适配。 */
  const untouched = useRef(true)
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 })

  /*
   * 回到「适应页面」：位移归零，倍率取刚好装得下的那一档。
   *
   * 位移零就是画布中心对准舞台中心 —— 居中不靠对齐属性，靠 transform 的第一段，任何倍率下
   * 都成立。
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

  /*
   * at 是指针相对框中心的位置。缩放前后让它底下那个点原地不动，图就是「以指针为锚」在放大；
   * 不给 at 就围绕视野中心 —— 按钮走的是这一条。
   */
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
   * 上屏走 ref 回调，不走 effect：effect 只在依赖变化时跑，而节点是否已经挂上去与依赖无关。
   * ref 回调由 React 在挂载那一刻调用，数据先到还是节点先到都成立。这一片 DOM 归这个回调独
   * 有，所以它下面不放任何 React 子节点。
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
       * 换了一张图就在这里重新适配。
       *
       * 此前它是一个 useEffect，依赖写着 graphic —— 而 graphic 是这个 hook 的入参，
       * 不是 hook 自己声明的值：拿它当依赖，规则判它是外层作用域的变量（biome 的
       * useExhaustiveDependencies）。按建议把它从依赖里删掉则更糟：换图之后再没有
       * 任何东西触发适配。
       *
       * 尺寸就是上一行 ground() 刚量出来的，所以适配的正确位置本来就是这里：节点
       * 上屏与按新尺寸铺满是同一件事，不必再绕一趟 effect。
       */
      home()
    },
    [graphic, home],
  )

  /*
   * 框的尺寸不是一开始就知道的：窗口会缩放，面板在源码视图下是 display: none（量出来是零），
   * 切回来才有真实尺寸。ResizeObserver 是平台官方的答案，它在开始观察时先报一次当前尺寸，
   * 首屏那次适配也一并由它兜住。
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

  /*
   * 按住拖。setPointerCapture 之后指针滑出面板、滑出窗口都还算数，松手才结束 —— 这是指针事
   * 件规范给的能力，自己在 window 上补 mousemove / mouseup 是同一件事的手写版。
   */
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
            <button
              aria-label="适应页面"
              className="timeline-prose__diagram-tool"
              onClick={canvas.home}
              type="button"
            >
              <ResetIcon aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {failure !== undefined && (
        <p className="timeline-prose__diagram-alert">这段 mermaid 没能画出来：{failure}</p>
      )}
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
