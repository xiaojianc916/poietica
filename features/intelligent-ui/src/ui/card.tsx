import './card.css'

import { Dialog } from '@poietica/design-system'
import type { ToolCallRendererProps } from '@poietica/feature-conversation/ui-api'
import { Download, Image as ImageIcon, Maximize2, RotateCcw, SlidersHorizontal } from 'lucide-react'
import {
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { INTELLIGENT_UI_SHELL_URL, INTELLIGENT_UI_WIDE_WIDTH, type IntelligentUiState } from '../contract'
import {
  failureOf,
  type TweakControl,
  type TweakGroup,
  type TweakValue,
  tokenCss,
  type ViewArgs,
  viewArgsOf,
  viewDraftOf,
  viewTitleOf,
} from './bridge'
import {
  canUseTools,
  type FrameActions,
  type FrameAsk,
  type FrameSession,
  openFrameSession,
  performAsk,
  tweakingAfterGroups,
} from './frame-session'
import { createHeightCache, createRecentCache, HEIGHT_CACHE_LIMIT } from './height-cache'

/*
 * iframe 装 poietica-asset://intelligent-ui 外壳，sandbox 只给 allow-scripts allow-forms —— 不同源，碰不到这个窗口；
 * 往来只走 frame-session.ts 的私有端口。
 *
 * 实例的身份是 callId：状态按它存取（Core 的 intelligent_ui_states），量过的高度按它缓存。时间线是虚拟列表，
 * 行滚出视口 iframe 就销毁；滚回来先按缓存的高度占位，再用读回的状态重建界面。
 *
 * 第二阶段：
 * - 参数还在流（argsStreaming）或工具还没跑完：同一个 iframe 先画预览（外壳不跑脚本），下面一行「正在生成」；
 *   succeeded 时在原地换成真界面。iframe 的会话只跟 callId 走，参数变了只推新的一版，不重建；
 * - 悬停时右上角一排工具：调整（界面登记了控件才有）、复制为图片、导出 HTML、展开（对话框里原尺寸再开一个实例，
 *   时间线里那个换成占位 —— 同一时间只有一个实例在写状态）；
 * - wide：按 1100px 排版，整体缩放到正文栏的宽度。
 */

export interface CardToast {
  readonly severity: 'success' | 'info'
  readonly title: string
  readonly detail?: string
  readonly action?: { readonly label: string; readonly run: () => void }
}

export interface ExportRequest {
  readonly title: string
  readonly html: string
  readonly bare: boolean
  readonly wide: boolean
  readonly css: string
  readonly theme: 'dark' | 'light'
  readonly state: IntelligentUiState
}

export interface IntelligentUiCardDeps {
  readonly send: (threadId: string, text: string) => void
  /** 放进输入框，不发送 */
  readonly draft: (threadId: string, text: string) => void
  readonly openExternal: (url: string) => void
  readonly loadState: (threadId: string, callId: string) => Promise<IntelligentUiState | null>
  readonly saveState: (threadId: string, callId: string, title: string, state: IntelligentUiState) => Promise<void>
  /** 截主窗口里这块矩形（CSS 像素）放进剪贴板 */
  readonly copyImage: (rect: { x: number; y: number; width: number; height: number }) => Promise<void>
  /** 用户取消保存为 null */
  readonly exportHtml: (request: ExportRequest) => Promise<string | null>
  readonly showInFolder: (path: string) => void
  readonly toast: (toast: CardToast) => void
  readonly toastError: (cause: unknown, title: string) => void
}

const ASK_PREVIEW_MAX = 120
const EMPTY_STATE: IntelligentUiState = { model: null, view: null, tweaks: null }

/* 模块级：跨行的卸载与重建都在（虚拟列表回收的就是组件实例） */
const heights = createHeightCache()
const states = createRecentCache<IntelligentUiState>(HEIGHT_CACHE_LIMIT)

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

function sizeOf(html: string): string {
  return `${(html.length / 1024).toFixed(1)} KB`
}

/** 等浏览器真的画过一帧（藏起工具条之后再截图） */
function painted(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
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

function ToolButton({
  label,
  onClick,
  pressed,
  children,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly pressed?: boolean
  readonly children: ReactNode
}): ReactNode {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className="intelligent-ui__button"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

function TweakField({
  control,
  value,
  onChange,
}: {
  readonly control: TweakControl
  readonly value: TweakValue
  readonly onChange: (value: TweakValue) => void
}): ReactNode {
  switch (control.type) {
    case 'range':
      return (
        <label className="intelligent-ui__tweak">
          <span className="intelligent-ui__tweak-label">{control.label}</span>
          <input
            max={control.max}
            min={control.min}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
            step={control.step}
            type="range"
            value={Number(value)}
          />
          <output className="intelligent-ui__tweak-value">
            {String(value)}
            {control.unit}
          </output>
        </label>
      )
    case 'color':
      return (
        <label className="intelligent-ui__tweak">
          <span className="intelligent-ui__tweak-label">{control.label}</span>
          <input onChange={(event) => onChange(event.currentTarget.value)} type="color" value={String(value)} />
          <output className="intelligent-ui__tweak-value">{String(value)}</output>
        </label>
      )
    case 'toggle':
      return (
        <label className="intelligent-ui__tweak">
          <span className="intelligent-ui__tweak-label">{control.label}</span>
          <input checked={value === true} onChange={(event) => onChange(event.currentTarget.checked)} type="checkbox" />
        </label>
      )
    case 'select':
      return (
        <label className="intelligent-ui__tweak">
          <span className="intelligent-ui__tweak-label">{control.label}</span>
          <select onChange={(event) => onChange(event.currentTarget.value)} value={String(value)}>
            {control.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )
  }
}

/*
 * 调整面板：界面经 poietica.tweak 登记的控件，画在界面外面（原生控件，跟着应用的主题）。改的值经端口回送，
 * 外壳记进状态的 tweaks —— 用户下一句话时随 model 一起交给模型，界面重建时还原。
 */
function TweakPanel({
  groups,
  onChange,
}: {
  readonly groups: readonly TweakGroup[]
  readonly onChange: (id: number, values: Readonly<Record<string, TweakValue>>) => void
}): ReactNode {
  return (
    <section aria-label="调整" className="intelligent-ui__tweaks">
      {groups.map((group) => {
        const changed = group.controls.some((control) => group.values[control.key] !== control.value)
        return (
          <fieldset className="intelligent-ui__tweak-group" key={group.id}>
            <legend className="intelligent-ui__tweak-legend">{group.label}</legend>
            {group.controls.map((control) => (
              <TweakField
                control={control}
                key={control.key}
                onChange={(value) => onChange(group.id, { [control.key]: value })}
                value={group.values[control.key] ?? control.value}
              />
            ))}
            <button
              className="intelligent-ui__link intelligent-ui__link--quiet intelligent-ui__tweak-reset"
              disabled={!changed}
              onClick={() => onChange(group.id, Object.fromEntries(group.controls.map((c) => [c.key, c.value])))}
              type="button"
            >
              <RotateCcw aria-hidden size={12} strokeWidth={1.75} />
              重置
            </button>
          </fieldset>
        )
      })}
      <p className="intelligent-ui__tweak-hint">调过的值会在你下一句话时一并告诉 agent。</p>
    </section>
  )
}

/* wide：按 1100px 排版，量正文栏的宽度来缩放 */
function useWideScale(stage: { readonly current: HTMLDivElement | null }, wide: boolean): number {
  const [stageWidth, setStageWidth] = useState(0)
  useLayoutEffect(() => {
    const element = stage.current
    if (!wide || element === null) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined) setStageWidth(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [stage, wide])
  return wide && stageWidth > 0 ? Math.min(1, stageWidth / INTELLIGENT_UI_WIDE_WIDTH) : 1
}

function frameStyleOf(wide: boolean, height: number, scale: number): CSSProperties {
  if (!wide) return { height }
  return { width: INTELLIGENT_UI_WIDE_WIDTH, height, ...(scale < 1 ? { transform: `scale(${scale})` } : {}) }
}

/** 悬浮工具条（界面跑起来之后才有）：调整 / 复制为图片 / 导出 HTML / 展开 */
function FrameTools({
  tweaking,
  onTweak,
  onCopy,
  onExport,
  onExpand,
  capturing,
}: {
  readonly tweaking: boolean
  readonly onTweak: (() => void) | undefined
  readonly onCopy: () => void
  readonly onExport: () => void
  readonly onExpand: (() => void) | undefined
  /** 截图期间整条工具条 inert，免得键盘焦点跑进正在隐藏的那一条 */
  readonly capturing: boolean
}): ReactNode {
  return (
    <div aria-label="界面工具" className="intelligent-ui__tools" inert={capturing} role="toolbar">
      {onTweak === undefined ? null : (
        <ToolButton label="调整" onClick={onTweak} pressed={tweaking}>
          <SlidersHorizontal aria-hidden size={14} strokeWidth={1.75} />
        </ToolButton>
      )}
      <ToolButton label="复制为图片" onClick={onCopy}>
        <ImageIcon aria-hidden size={14} strokeWidth={1.75} />
      </ToolButton>
      <ToolButton label="导出 HTML" onClick={onExport}>
        <Download aria-hidden size={14} strokeWidth={1.75} />
      </ToolButton>
      {onExpand === undefined ? null : (
        <ToolButton label="展开" onClick={onExpand}>
          <Maximize2 aria-hidden size={14} strokeWidth={1.75} />
        </ToolButton>
      )}
    </div>
  )
}

/** 预览期间的状态行：参数还在流 → 正在生成；参数齐了、工具还没跑完 → 正在准备 */
function PendingLine({
  title,
  html,
  streaming,
}: {
  readonly title: string
  readonly html: string
  readonly streaming: boolean
}): ReactNode {
  const empty = html.trim() === ''
  return (
    <span className="intelligent-ui__pending timeline-shimmer">
      {streaming ? '正在生成' : '正在准备'}界面「{title}」{empty ? '' : ` · ${sizeOf(html)}`}
    </span>
  )
}

function FrameError({ error, onFix }: { readonly error: string; readonly onFix: () => void }): ReactNode {
  return (
    <div className="intelligent-ui__error" role="status">
      <span className="intelligent-ui__error-text">界面出错：{error}</span>
      <button className="intelligent-ui__link" onClick={onFix} type="button">
        让 agent 修复
      </button>
    </div>
  )
}

type FrameMode = 'inline' | 'expanded'

function HtmlFrame({
  deps,
  threadId,
  callId,
  view,
  live,
  streaming,
  mode,
  onExpand,
}: {
  readonly deps: IntelligentUiCardDeps
  readonly threadId: string
  readonly callId: string
  readonly view: ViewArgs
  /** false：参数还在流 / 工具还没跑完，只画预览 */
  readonly live: boolean
  /** 参数还在流（不只是工具还没跑完） */
  readonly streaming: boolean
  readonly mode: FrameMode
  readonly onExpand?: () => void
}): ReactNode {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const stateKey = `${threadId}\u0000${callId}`
  /* 展开的那个实例宽度不同，高度另记 */
  const cacheKey = mode === 'inline' ? stateKey : `${stateKey}\u0000expanded`
  /*
   * 高度只跟内容走。先用缓存的高度占位；没有缓存就 1px、量到再露，见 card.css。
   * ready 单独一格：占位期间外壳还是空白页，不露面。
   */
  const [height, setHeight] = useState<number | null>(() => heights.get(cacheKey) ?? null)
  const [ready, setReady] = useState(false)
  /* ready 只说明量到了高度（预览期也会报）；rendered 才是外壳真的交出了真界面 */
  const [rendered, setRendered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ask, setAsk] = useState<FrameAsk | null>(null)
  const [groups, setGroups] = useState<readonly TweakGroup[]>([])
  const [tweaking, setTweaking] = useState(false)
  const [capturing, setCapturing] = useState(false)
  /* load 可能先于 effect（极少见）：记下来，effect 起来时补交 */
  const loaded = useRef(false)
  const session = useRef<FrameSession | null>(null)
  const { bare, html, title, wide } = view

  const actions: FrameActions = {
    send: (text) => deps.send(threadId, text),
    draft: (text) => deps.draft(threadId, text),
    open: deps.openExternal,
    /* 刚卸载的实例最后那份状态可能还在写回的路上：先看本地记的 */
    loadState: async () => states.get(stateKey) ?? deps.loadState(threadId, callId),
    saveState: (state) => {
      states.set(stateKey, state)
      return deps.saveState(threadId, callId, title, state)
    },
  }
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const latest = useRef({ view, live })
  latest.current = { view, live }

  useEffect(() => {
    const element = frame.current
    if (element === null) return
    const first = latest.current
    setRendered(false)
    const opened = openFrameSession({
      content: { html: first.view.html, bare: first.view.bare, wide: first.view.wide },
      live: first.live,
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
        tweaks: setGroups,
        rendered: () => setRendered(true),
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
  }, [cacheKey])

  /* 参数又长了一截 / 定了：推给同一个会话（会话自己去重，定了之后不再回头） */
  useEffect(() => {
    const opened = session.current
    if (opened === null) return
    if (live) opened.finish({ html, bare, wide })
    else opened.preview(html)
  }, [bare, html, live, wide])

  /* 预览期间量到的高度不算数：工具条与三个动作都等真界面投递之后 */
  const liveReady = canUseTools(live, ready, rendered)
  useEffect(() => {
    setTweaking((open) => tweakingAfterGroups(open, groups.length))
  }, [groups.length])

  const scale = useWideScale(stage, wide)
  const frameHeight = height ?? 1
  const empty = html.trim() === ''

  const copyImage = async (): Promise<void> => {
    const element = frame.current
    if (!liveReady || element === null || capturing) return
    element.scrollIntoView({ block: 'nearest' })
    setCapturing(true)
    try {
      await painted()
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      const clipped = rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth
      await deps.copyImage({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      deps.toast({
        severity: 'success',
        title: '已复制为图片',
        ...(clipped ? { detail: '界面比窗口大，只截了窗口里看得见的那一部分' } : {}),
      })
    } catch (cause) {
      deps.toastError(cause, '没能复制为图片')
    } finally {
      setCapturing(false)
    }
  }

  const exportHtml = async (): Promise<void> => {
    const element = frame.current
    if (!liveReady || element === null) return
    try {
      const path = await deps.exportHtml({
        title,
        html,
        bare,
        wide,
        css: tokensAt(element),
        theme: themeNow(),
        state: session.current?.state() ?? EMPTY_STATE,
      })
      if (path === null) return
      deps.toast({
        severity: 'success',
        title: `已导出「${title}」`,
        action: { label: '在文件夹中显示', run: () => deps.showInFolder(path) },
      })
    } catch (cause) {
      deps.toastError(cause, '没能导出')
    }
  }

  return (
    <div
      className="intelligent-ui"
      data-capturing={capturing}
      data-mode={mode}
      data-ready={ready && !empty}
      data-source="html"
      data-wide={wide}
    >
      <div className="intelligent-ui__stage" ref={stage} style={wide ? { height: frameHeight * scale } : undefined}>
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
          style={frameStyleOf(wide, frameHeight, scale)}
          title={title}
        />
        {liveReady ? (
          <FrameTools
            capturing={capturing}
            onCopy={() => void copyImage()}
            onExpand={onExpand}
            onExport={() => void exportHtml()}
            onTweak={groups.length > 0 ? () => setTweaking((open) => !open) : undefined}
            tweaking={tweaking}
          />
        ) : null}
      </div>
      {live ? null : <PendingLine html={html} streaming={streaming} title={title} />}
      {liveReady && tweaking && groups.length > 0 ? (
        <TweakPanel groups={groups} onChange={(id, values) => session.current?.setTweak(id, values)} />
      ) : null}
      {ask === null ? null : <AskBar actions={actions} ask={ask} onDone={() => setAsk(null)} />}
      {error === null ? null : (
        <FrameError
          error={error}
          onFix={() => deps.send(threadId, `界面「${title}」报错：${error}\n请修复后重新展示。`)}
        />
      )}
    </div>
  )
}

function HtmlCard({
  deps,
  threadId,
  callId,
  view,
  live,
  streaming,
}: {
  readonly deps: IntelligentUiCardDeps
  readonly threadId: string
  readonly callId: string
  readonly view: ViewArgs
  readonly live: boolean
  readonly streaming: boolean
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const placeholder = heights.get(`${threadId}\u0000${callId}`)

  return (
    <>
      {expanded ? (
        <div className="intelligent-ui intelligent-ui__placeholder" style={{ minHeight: placeholder }}>
          <span>界面「{view.title}」已展开</span>
          <button className="intelligent-ui__link" onClick={() => setExpanded(false)} type="button">
            收起
          </button>
        </div>
      ) : (
        <HtmlFrame
          callId={callId}
          deps={deps}
          live={live}
          mode="inline"
          streaming={streaming}
          threadId={threadId}
          view={view}
          {...(live ? { onExpand: () => setExpanded(true) } : {})}
        />
      )}
      <Dialog
        className="intelligent-ui-dialog"
        contentClassName="intelligent-ui-dialog__body"
        onOpenChange={setExpanded}
        open={expanded}
        title={view.title}
      >
        {expanded ? (
          <HtmlFrame
            callId={callId}
            deps={deps}
            live={live}
            mode="expanded"
            streaming={false}
            threadId={threadId}
            view={view}
          />
        ) : null}
      </Dialog>
    </>
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
  return function IntelligentUiCard({
    args,
    argsStreaming,
    callId,
    result,
    status,
    threadId,
  }: ToolCallRendererProps): ReactNode {
    if (status === 'failed') return <ViewFailure message={failureOf(result)} title={viewTitleOf(args)} />
    /* 参数还在流、或工具还没跑完：预览。succeeded 才当真（工具那一侧校验过 html） */
    const live = status === 'succeeded'
    const view = live ? viewArgsOf(args) : viewDraftOf(args)
    if (view === null) return <ViewFailure message="界面没有内容" title={viewTitleOf(args)} />
    return (
      <HtmlCard
        callId={callId}
        deps={deps}
        live={live}
        streaming={!live && argsStreaming === true}
        threadId={threadId}
        view={view}
      />
    )
  }
}
