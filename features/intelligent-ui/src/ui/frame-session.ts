import type { IntelligentUiState } from '../contract'
import { externalUrlOf, type FrameMessage, parseFrameMessage } from './bridge'

/*
 * 一个 html 界面实例与外壳之间的那条私有通道（不碰 React，便于单测）。
 *
 * - 建一条 MessageChannel，iframe 第一次 load 时把 port2 随 poietica:render 交给外壳；之后的往来只走 port1。
 *   UI 不监听 window 的 message —— 界面自己 parent.postMessage 的东西一律到不了这里；
 * - 状态：挂载时先读回（读失败当没有），与 render 一起交给外壳；外壳报 state 时攒一会儿再整份写回，
 *   卸载时立刻写掉没写完的那份。写失败不重试：写是整份覆盖，下一次 setState 自然补上；
 * - send / draft / open：外壳证明有手势、父窗口也处在瞬时激活里，才直接办；否则交给卡片画确认条。
 *   send 另有 1 秒间隔，太密的那一条同样改成确认。
 */

export type FrameAsk =
  | { readonly kind: 'send' | 'draft'; readonly text: string }
  | { readonly kind: 'open'; readonly url: string }

export interface FrameActions {
  readonly send: (text: string) => void
  readonly draft: (text: string) => void
  readonly open: (url: string) => void
  readonly loadState: () => Promise<IntelligentUiState | null>
  readonly saveState: (state: IntelligentUiState) => Promise<void>
}

export interface FrameView {
  /** iframe.contentWindow.postMessage(message, '*', transfer)：外壳是不透明源，只能写 '*' */
  readonly deliver: (message: unknown, transfer: Transferable[]) => void
  readonly look: () => { readonly css: string; readonly theme: 'dark' | 'light' }
  /** 父窗口的 navigator.userActivation.isActive：iframe 里的真实点击会把瞬时激活传到祖先窗口 */
  readonly userActive: () => boolean
  readonly resize: (height: number) => void
  readonly fail: (message: string) => void
  readonly ask: (ask: FrameAsk) => void
}

export interface FrameSession {
  /** iframe 第一次 load：交出端口与界面。重复调用（界面把自己导航走了又 load）不再交第二次 */
  start(): void
  /** 主题变了：令牌重新求值后推给界面（界面不重跑） */
  retheme(): void
  dispose(): void
}

export const SEND_INTERVAL_MS = 1000
export const STATE_SAVE_DELAY_MS = 300

export function performAsk(actions: FrameActions, ask: FrameAsk): void {
  if (ask.kind === 'open') actions.open(ask.url)
  else if (ask.kind === 'draft') actions.draft(ask.text)
  else actions.send(ask.text)
}

function askOf(message: Extract<FrameMessage, { type: 'send' | 'draft' | 'open' }>): FrameAsk | null {
  if (message.type !== 'open') return { kind: message.type, text: message.text }
  const url = externalUrlOf(message.url)
  return url === null ? null : { kind: 'open', url }
}

export function openFrameSession(o: {
  readonly html: string
  readonly bare: boolean
  readonly actions: FrameActions
  readonly view: FrameView
  readonly now?: () => number
}): FrameSession {
  const now = o.now ?? Date.now
  const channel = new MessageChannel()
  const port = channel.port1
  const initial = o.actions.loadState().catch(() => null)
  let started = false
  let disposed = false
  let lastSend = Number.NEGATIVE_INFINITY
  let unsaved: IntelligentUiState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const save = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (unsaved === null) return
    const state = unsaved
    unsaved = null
    void o.actions.saveState(state).catch(() => undefined)
  }

  const act = (message: Extract<FrameMessage, { type: 'send' | 'draft' | 'open' }>): void => {
    const ask = askOf(message)
    if (ask === null) return
    if (!(message.gesture && o.view.userActive())) {
      o.view.ask(ask)
      return
    }
    if (ask.kind === 'send') {
      const at = now()
      if (at - lastSend < SEND_INTERVAL_MS) {
        o.view.ask(ask)
        return
      }
      lastSend = at
    }
    performAsk(o.actions, ask)
  }

  const route = (message: FrameMessage): void => {
    switch (message.type) {
      case 'height':
        o.view.resize(message.height)
        return
      case 'state':
        unsaved = { model: message.model, view: message.view }
        if (timer === null) timer = setTimeout(save, STATE_SAVE_DELAY_MS)
        return
      case 'error':
        o.view.fail(message.message)
        return
      default:
        act(message)
    }
  }

  port.onmessage = (event: MessageEvent) => {
    if (disposed) return
    const message = parseFrameMessage(event.data)
    if (message !== null) route(message)
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      void initial.then((state) => {
        if (disposed) return
        const { css, theme } = o.view.look()
        o.view.deliver({ type: 'poietica:render', html: o.html, css, theme, bare: o.bare, state }, [channel.port2])
      })
    },
    retheme() {
      if (!started || disposed) return
      const { css, theme } = o.view.look()
      port.postMessage({ type: 'theme', css, theme })
    },
    dispose() {
      if (disposed) return
      disposed = true
      save()
      port.close()
    },
  }
}
