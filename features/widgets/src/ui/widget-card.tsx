import './widget-card.css'

import type { ToolCallRendererProps } from '@poietica/feature-conversation/ui-api'
import { ExternalLink, RotateCw } from 'lucide-react'
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from 'react'
import { WIDGET_SHELL_URL } from '../contract'
import {
  externalUrlOf,
  parseWidgetMessage,
  type WidgetArgs,
  type WidgetMessage,
  widgetAddressOf,
  widgetArgsOf,
  widgetFailureOf,
  widgetTitleOf,
  widgetTokenCss,
} from './widget-bridge'

/*
 * html：iframe 装 poietica-asset://widget 外壳，sandbox 只给 allow-scripts allow-forms —— 不同源，碰不到这个窗口。url：用户自己的项目，要 allow-same-origin 才能跑，所以拒绝同源地址。
 * send / draft / open 只在焦点在这个 iframe 上时才认：组件是模型写的代码，不能自己替用户发消息。send 另有 1 秒节流。
 */

export interface WidgetCardDeps {
  readonly send: (threadId: string, text: string) => void
  /** 放进输入框，不发送 */
  readonly draft: (threadId: string, text: string) => void
  readonly openExternal: (url: string) => void
}

const URL_DEFAULT_HEIGHT = 560
const SEND_INTERVAL_MS = 1000

function themeNow(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

function tokensAt(element: Element): string {
  const computed = getComputedStyle(element)
  return widgetTokenCss((token) => computed.getPropertyValue(token))
}

function ReloadButton({ onReload, label }: { readonly onReload: () => void; readonly label: string }): ReactNode {
  return (
    <button aria-label={label} className="timeline-widget__button" onClick={onReload} title={label} type="button">
      <RotateCw aria-hidden size={14} strokeWidth={1.75} />
    </button>
  )
}

interface FrameContext {
  readonly deps: WidgetCardDeps
  readonly threadId: string
  readonly lastSend: { current: number }
  /** 焦点在这个 iframe 上 = 用户刚在组件里操作过；发消息、填输入框、开链接都要这个前提 */
  readonly interacting: () => boolean
  readonly render: () => void
  readonly resize: (height: number) => void
  readonly fail: (message: string) => void
}

function routeWidgetMessage(message: WidgetMessage, at: FrameContext): void {
  switch (message.type) {
    case 'ready':
      at.render()
      return
    case 'height':
      at.resize(message.height)
      return
    case 'error':
      at.fail(message.message)
      return
    default:
      actForUser(message, at)
  }
}

/** 组件替用户做的三件事：没有用户操作一律不做 */
function actForUser(message: Extract<WidgetMessage, { type: 'send' | 'draft' | 'open' }>, at: FrameContext): void {
  if (!at.interacting()) return
  if (message.type === 'draft') {
    at.deps.draft(at.threadId, message.text)
    return
  }
  if (message.type === 'open') {
    const url = externalUrlOf(message.url)
    if (url !== null) at.deps.openExternal(url)
    return
  }
  const now = Date.now()
  if (now - at.lastSend.current < SEND_INTERVAL_MS) return
  at.lastSend.current = now
  at.deps.send(at.threadId, message.text)
}

function HtmlFrame({
  deps,
  threadId,
  widget,
}: {
  readonly deps: WidgetCardDeps
  readonly threadId: string
  readonly widget: WidgetArgs & { readonly html: string }
}): ReactNode {
  const frame = useRef<HTMLIFrameElement | null>(null)
  /*
   * 高度只跟内容走。window.height 是给 url 来源的固定窗高；html 用它会把组件钉在半屏空白上
   * （模型随手写的 300 与内容无关）。首帧 1px、量到再露，见 widget-card.css。
   */
  const [height, setHeight] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastSend = useRef(0)
  const { bare, html, title } = widget

  useEffect(() => {
    const element = frame.current
    if (element === null) return
    const post = (message: unknown): void => {
      element.contentWindow?.postMessage(message, '*')
    }
    const at: FrameContext = {
      deps,
      threadId,
      lastSend,
      interacting: () => document.activeElement === element,
      render: () => {
        post({ type: 'poietica:render', html, css: tokensAt(element), theme: themeNow(), bare })
      },
      resize: (next) => {
        setHeight(Math.max(next, 24))
      },
      fail: setError,
    }
    const onMessage = (event: MessageEvent): void => {
      if (event.source === null || event.source !== element.contentWindow) return
      const message = parseWidgetMessage(event.data)
      if (message !== null) routeWidgetMessage(message, at)
    }

    window.addEventListener('message', onMessage)
    /* 换主题只换 data-theme：令牌重新求值后推给组件（组件不重跑） */
    const watch = new MutationObserver(() => {
      post({ type: 'poietica:theme', css: tokensAt(element), theme: themeNow() })
    })
    watch.observe(document.documentElement, { attributeFilter: ['data-theme'], attributes: true })
    return () => {
      window.removeEventListener('message', onMessage)
      watch.disconnect()
    }
  }, [bare, deps, html, threadId])

  return (
    <div className="timeline-widget" data-ready={height !== null} data-source="html">
      <iframe
        className="timeline-widget__frame"
        ref={frame}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms"
        src={WIDGET_SHELL_URL}
        style={{ height: height ?? 1 }}
        title={title}
      />
      {error === null ? null : (
        <div className="timeline-widget__error" role="status">
          <span className="timeline-widget__error-text">组件出错：{error}</span>
          <button
            className="timeline-widget__link"
            onClick={() => {
              deps.send(threadId, `组件「${title}」报错：${error}\n请修复后重新展示。`)
            }}
            type="button"
          >
            让 agent 修复
          </button>
        </div>
      )}
    </div>
  )
}

function UrlWidget({
  deps,
  widget,
}: {
  readonly deps: WidgetCardDeps
  readonly widget: WidgetArgs & { readonly url: string }
}): ReactNode {
  const [generation, setGeneration] = useState(0)
  const { title, url } = widget

  /* allow-same-origin 之下同源就等于把整个窗口交出去 */
  let sameOrigin = false
  try {
    sameOrigin = new URL(url).origin === window.location.origin
  } catch {
    sameOrigin = true
  }
  if (sameOrigin) return <WidgetFailure message={`不能嵌入 Poietica 自己的页面：${url}`} title={title} />

  return (
    <div className="timeline-widget" data-ready="true" data-source="url">
      <div className="timeline-widget__bar">
        <span className="timeline-widget__address" title={url}>
          {widgetAddressOf(url)}
        </span>
        <ReloadButton
          label="刷新"
          onReload={() => {
            setGeneration((value) => value + 1)
          }}
        />
        <button
          aria-label="在浏览器中打开"
          className="timeline-widget__button"
          onClick={() => {
            deps.openExternal(url)
          }}
          title="在浏览器中打开"
          type="button"
        >
          <ExternalLink aria-hidden size={14} strokeWidth={1.75} />
        </button>
      </div>
      <iframe
        className="timeline-widget__frame"
        key={generation}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        src={url}
        style={{ height: widget.height ?? URL_DEFAULT_HEIGHT }}
        title={title}
      />
    </div>
  )
}

function WidgetPending({ title }: { readonly title: string }): ReactNode {
  return (
    <div className="timeline-widget" data-source="pending">
      <span className="timeline-widget__pending timeline-shimmer">正在准备组件「{title}」</span>
    </div>
  )
}

function WidgetFailure({ message, title }: { readonly message: string; readonly title: string }): ReactNode {
  return (
    <div className="timeline-widget" data-source="failed">
      <span className="timeline-widget__failure">
        组件「{title}」没能显示：{message}
      </span>
    </div>
  )
}

export function createWidgetCard(deps: WidgetCardDeps): ComponentType<ToolCallRendererProps> {
  return function WidgetCard({ args, result, status, threadId }: ToolCallRendererProps): ReactNode {
    if (status === 'failed') return <WidgetFailure message={widgetFailureOf(result)} title={widgetTitleOf(args)} />
    const widget = widgetArgsOf(args)
    if (status === 'running' || widget === null) return <WidgetPending title={widgetTitleOf(args)} />
    if (widget.html !== undefined)
      return <HtmlFrame deps={deps} threadId={threadId} widget={{ ...widget, html: widget.html }} />
    if (widget.url !== undefined) return <UrlWidget deps={deps} widget={{ ...widget, url: widget.url }} />
    return null
  }
}
