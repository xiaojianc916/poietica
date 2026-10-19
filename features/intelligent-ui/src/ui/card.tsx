import './card.css'

import type { ToolCallRendererProps } from '@poietica/feature-conversation/ui-api'
import { ExternalLink, RotateCw } from 'lucide-react'
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from 'react'
import { INTELLIGENT_UI_SHELL_URL, type IntelligentUiState } from '../contract'
import { addressOf, failureOf, tokenCss, type ViewArgs, viewArgsOf, viewTitleOf } from './bridge'
import { type FrameActions, type FrameAsk, type FrameSession, openFrameSession, performAsk } from './frame-session'
import { createHeightCache } from './height-cache'

/*
 * html：iframe 装 poietica-asset://intelligent-ui 外壳，sandbox 只给 allow-scripts allow-forms —— 不同源，碰不到这个窗口；
 * 往来只走 frame-session.ts 的私有端口。url：用户自己的项目，要 allow-same-origin 才能跑，所以拒绝同源地址。
 *
 * 实例的身份是 callId：状态按它存取（Core 的 intelligent_ui_states），量过的高度按它缓存。时间线是虚拟列表，
 * 行滚出视口 iframe 就销毁；滚回来先按缓存的高度占位，再用读回的状态重建界面。
 */

export interface IntelligentUiCardDeps {
  readonly send: (threadId: string, text: string) => void
  /** 放进输入框，不发送 */
  readonly draft: (threadId: string, text: string) => void
  readonly openExternal: (url: string) => void
  readonly loadState: (threadId: string, callId: string) => Promise<IntelligentUiState | null>
  readonly saveState: (threadId: string, callId: string, title: string, state: IntelligentUiState) => Promise<void>
}

const URL_DEFAULT_HEIGHT = 560
const ASK_PREVIEW_MAX = 120

/* 模块级：跨行的卸载与重建都在（虚拟列表回收的就是组件实例） */
const heights = createHeightCache()

function themeNow(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

function tokensAt(element: Element): string {
  const computed = getComputedStyle(element)
  return tokenCss((token) => computed.getPropertyValue(token))
}

function preview(text: string): string {
  return text.length > ASK_PREVIEW_MAX ? `${text.slice(0, ASK_PREVIEW_MAX)}…` : text
}

function ReloadButton({ onReload, label }: { readonly onReload: () => void; readonly label: string }): ReactNode {
  return (
    <button aria-label={label} className="intelligent-ui__button" onClick={onReload} title={label} type="button">
      <RotateCw aria-hidden size={14} strokeWidth={1.75} />
    </button>
  )
}

/*
 * 界面在没有手势时想替用户做事：不再静默丢掉（旧版的做法让「点了没反应」与「界面坏了」分不清），
 * 也不替用户做 —— 摆一条确认，用户自己点。只在有请求时出现，办完就消失，不是常驻页脚（R-40）。
 */
function AskBar({
  ask,
  actions,
  onDone,
}: {
  readonly ask: FrameAsk
  readonly actions: FrameActions
  readonly onDone: () => void
}): ReactNode {
  const run = (next: FrameAsk): void => {
    performAsk(actions, next)
    onDone()
  }
  const said = ask.kind === 'open' ? ask.url : preview(ask.text)
  const lead = ask.kind === 'send' ? '界面想替你发送' : ask.kind === 'draft' ? '界面想放进输入框' : '界面想打开链接'

  return (
    <div className="intelligent-ui__ask" role="alert">
      <span className="intelligent-ui__ask-text">
        {lead}：{ask.kind === 'open' ? said : `「${said}」`}
      </span>
      {ask.kind === 'open' ? (
        <button className="intelligent-ui__link" onClick={() => run(ask)} type="button">
          打开
        </button>
      ) : null}
      {ask.kind === 'send' ? (
        <button className="intelligent-ui__link" onClick={() => run(ask)} type="button">
          发送
        </button>
      ) : null}
      {ask.kind === 'open' ? null : (
        <button className="intelligent-ui__link" onClick={() => run({ kind: 'draft', text: ask.text })} type="button">
          放进输入框
        </button>
      )}
      <button className="intelligent-ui__link intelligent-ui__link--quiet" onClick={onDone} type="button">
        忽略
      </button>
    </div>
  )
}

function HtmlFrame({
  deps,
  threadId,
  callId,
  view,
}: {
  readonly deps: IntelligentUiCardDeps
  readonly threadId: string
  readonly callId: string
  readonly view: ViewArgs & { readonly html: string }
}): ReactNode {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const cacheKey = `${threadId}\u0000${callId}`
  /*
   * 高度只跟内容走（view.height 是给 url 来源的固定窗高）。先用缓存的高度占位；没有缓存就 1px、量到再露，
   * 见 card.css。ready 单独一格：占位期间外壳还是空白页，不露面。
   */
  const [height, setHeight] = useState<number | null>(() => heights.get(cacheKey) ?? null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ask, setAsk] = useState<FrameAsk | null>(null)
  /* load 可能先于 effect（极少见）：记下来，effect 起来时补交 */
  const loaded = useRef(false)
  const session = useRef<FrameSession | null>(null)
  const { bare, html, title } = view

  const actions: FrameActions = {
    send: (text) => deps.send(threadId, text),
    draft: (text) => deps.draft(threadId, text),
    open: deps.openExternal,
    loadState: () => deps.loadState(threadId, callId),
    saveState: (state) => deps.saveState(threadId, callId, title, state),
  }
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  useEffect(() => {
    const element = frame.current
    if (element === null) return
    const opened = openFrameSession({
      html,
      bare,
      actions: {
        send: (text) => actionsRef.current.send(text),
        draft: (text) => actionsRef.current.draft(text),
        open: (url) => actionsRef.current.open(url),
        loadState: () => actionsRef.current.loadState(),
        saveState: (state) => actionsRef.current.saveState(state),
      },
      view: {
        deliver: (message, transfer) => element.contentWindow?.postMessage(message, '*', transfer),
        look: () => ({ css: tokensAt(element), theme: themeNow() }),
        userActive: () => navigator.userActivation.isActive,
        resize: (next) => {
          const measured = Math.max(next, 24)
          heights.set(cacheKey, measured)
          setHeight(measured)
          setReady(true)
        },
        fail: setError,
        ask: setAsk,
      },
    })
    session.current = opened
    if (loaded.current) opened.start()
    /* 换主题只换 data-theme：令牌重新求值后推给界面（界面不重跑） */
    const watch = new MutationObserver(() => opened.retheme())
    watch.observe(document.documentElement, { attributeFilter: ['data-theme'], attributes: true })
    return () => {
      watch.disconnect()
      if (session.current === opened) session.current = null
      opened.dispose()
    }
  }, [bare, cacheKey, html])

  return (
    <div className="intelligent-ui" data-ready={ready} data-source="html">
      <iframe
        className="intelligent-ui__frame"
        onLoad={() => {
          if (loaded.current) return
          loaded.current = true
          session.current?.start()
        }}
        ref={frame}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms"
        src={INTELLIGENT_UI_SHELL_URL}
        style={{ height: height ?? 1 }}
        title={title}
      />
      {ask === null ? null : <AskBar actions={actions} ask={ask} onDone={() => setAsk(null)} />}
      {error === null ? null : (
        <div className="intelligent-ui__error" role="status">
          <span className="intelligent-ui__error-text">界面出错：{error}</span>
          <button
            className="intelligent-ui__link"
            onClick={() => {
              deps.send(threadId, `界面「${title}」报错：${error}\n请修复后重新展示。`)
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

function UrlFrame({
  deps,
  view,
}: {
  readonly deps: IntelligentUiCardDeps
  readonly view: ViewArgs & { readonly url: string }
}): ReactNode {
  const [generation, setGeneration] = useState(0)
  const { title, url } = view

  /* allow-same-origin 之下同源就等于把整个窗口交出去 */
  let sameOrigin = false
  try {
    sameOrigin = new URL(url).origin === window.location.origin
  } catch {
    sameOrigin = true
  }
  if (sameOrigin) return <ViewFailure message={`不能嵌入 Poietica 自己的页面：${url}`} title={title} />

  return (
    <div className="intelligent-ui" data-ready="true" data-source="url">
      <div className="intelligent-ui__bar">
        <span className="intelligent-ui__address" title={url}>
          {addressOf(url)}
        </span>
        <ReloadButton
          label="刷新"
          onReload={() => {
            setGeneration((value) => value + 1)
          }}
        />
        <button
          aria-label="在浏览器中打开"
          className="intelligent-ui__button"
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
        className="intelligent-ui__frame"
        key={generation}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        src={url}
        style={{ height: view.height ?? URL_DEFAULT_HEIGHT }}
        title={title}
      />
    </div>
  )
}

function ViewPending({ title }: { readonly title: string }): ReactNode {
  return (
    <div className="intelligent-ui" data-source="pending">
      <span className="intelligent-ui__pending timeline-shimmer">正在准备界面「{title}」</span>
    </div>
  )
}

function ViewFailure({ message, title }: { readonly message: string; readonly title: string }): ReactNode {
  return (
    <div className="intelligent-ui" data-source="failed">
      <span className="intelligent-ui__failure">
        界面「{title}」没能显示：{message}
      </span>
    </div>
  )
}

export function createIntelligentUiCard(deps: IntelligentUiCardDeps): ComponentType<ToolCallRendererProps> {
  return function IntelligentUiCard({ args, callId, result, status, threadId }: ToolCallRendererProps): ReactNode {
    if (status === 'failed') return <ViewFailure message={failureOf(result)} title={viewTitleOf(args)} />
    const view = viewArgsOf(args)
    if (status === 'running' || view === null) return <ViewPending title={viewTitleOf(args)} />
    if (view.html !== undefined)
      return <HtmlFrame callId={callId} deps={deps} threadId={threadId} view={{ ...view, html: view.html }} />
    if (view.url !== undefined) return <UrlFrame deps={deps} view={{ ...view, url: view.url }} />
    return null
  }
}
