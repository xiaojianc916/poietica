import { INTELLIGENT_UI_TWEAK_GROUPS_MAX, type IntelligentUiState } from '../contract'
import { coerceTweak, externalUrlOf, type FrameMessage, parseFrameMessage, type TweakGroup } from './bridge'

/*
 * 一个 html 界面实例与外壳之间的那条私有通道（不碰 React，便于单测）。
 *
 * - 建一条 MessageChannel，iframe 第一次 load 时把 port2 随 poietica:render 交给外壳；之后的往来只走 port1。
 *   UI 不监听 window 的 message —— 界面自己 parent.postMessage 的东西一律到不了这里；
 * - 预览（第二阶段）：参数还在流时先以 preview 交出（外壳不跑脚本，只画已经写出来的那部分），之后每来一版
 *   html 就推一次 preview；参数定了 finish() 在同一个 iframe 里换成真界面 —— 不重建 iframe，没有闪一下的空白；
 * - 状态：变成真界面之前先读回（读失败当没有），与 render 一起交给外壳；外壳报 state 时攒一会儿再整份写回，
 *   卸载时立刻写掉没写完的那份。写失败不重试：写是整份覆盖，下一次 setState 自然补上；
 * - 调整面板：外壳转来界面登记的控件组，交给卡片画；卡片改了值经 setTweak 回送，外壳记进状态的 tweaks；
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
  /** 界面登记 / 撤掉了调整控件，或值变了 */
  readonly tweaks: (groups: readonly TweakGroup[]) => void
  /** render 已经成功投递给外壳（预览量到的高度不算），卡片据此才露出工具条 */
  readonly rendered: () => void
  /** 焦点在界面里时按了 Esc（展开的对话框靠它关闭；时间线里的那一份不理） */
  readonly escape?: () => void
}

/** 真界面的那三项（预览期间 bare / wide 也已经在用） */
export interface FrameContent {
  readonly html: string
  readonly bare: boolean
  readonly wide: boolean
}

export interface FrameSession {
  /** iframe 第一次 load：交出端口与界面。重复调用（界面把自己导航走了又 load）不再交第二次 */
  start(): void
  /** 参数又长了一截：换预览。已经是真界面了就不理 */
  preview(html: string): void
  /** 参数定了：换成真界面（投递失败后可以再试） */
  finish(content: FrameContent): void
  /** 主题变了：令牌重新求值后推给界面（界面不重跑） */
  retheme(): void
  /** 卡片的调整面板改了值（只送这一组里给出的那几项） */
  /** 入参来自界面，运行时可能是任何东西，这里必须自己防住 */
  setTweak(id: number, values: unknown): void
  /** 当前的状态（导出时带上）：最近一次外壳报来的，没有就是读回的那份 */
  state(): IntelligentUiState
  dispose(): void
}

export const SEND_INTERVAL_MS = 1000
export const STATE_SAVE_DELAY_MS = 300

const EMPTY_STATE: IntelligentUiState = { model: null, view: null, tweaks: null }

/**
 * 卡片工具条 / 复制 / 导出 / 展开的共同前提：真界面已经投递，并且高度已经量到。
 * 预览期也会报 height，所以 ready 不能单独代表界面真的跑起来了。
 */
export function canUseTools(live: boolean, ready: boolean, rendered: boolean): boolean {
  return live && ready && rendered
}

/** 调整组全撤掉时面板必须收起；不能只靠渲染条件，否则 tweaking 状态会残留到下一组 */
export function tweakingAfterGroups(tweaking: boolean, groupCount: number): boolean {
  return groupCount === 0 ? false : tweaking
}

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

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() !== '' ? cause.message : '界面没能显示'
}

export function openFrameSession(o: {
  /** 还在预览时的那一版；live 为 true 时就是真界面 */
  readonly content: FrameContent
  readonly live: boolean
  readonly actions: FrameActions
  readonly view: FrameView
  readonly now?: () => number
}): FrameSession {
  const now = o.now ?? Date.now
  const channel = new MessageChannel()
  const port = channel.port1
  let content = o.content
  /* 预览只在还没变成真界面时有意义；finish 之后 live 不再回头 */
  let live = o.live
  let initial: Promise<IntelligentUiState | null> | null = null
  let started = false
  let rendered = false
  /*
   * renderPosted 在 postMessage / deliver 之前同步置位：外壳收到 render 后紧跟着回来的 state / error
   * 不能落进「预览期只认 height」的过滤里。rendered 在投递返回之后才置位，只表示投递完成、rendered()
   * 可以通知一次；两者不能合并，否则要么丢消息，要么在投递失败时误报界面已经起来。
   */
  let renderPosted = false
  let rendering = false
  let channelHandedOff = false
  let disposed = false
  let lastSend = Number.NEGATIVE_INFINITY
  let current: IntelligentUiState = EMPTY_STATE
  let unsaved: IntelligentUiState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const groups = new Map<number, TweakGroup>()

  const loadOnce = (): Promise<IntelligentUiState | null> => {
    initial ??= o.actions.loadState().catch(() => null)
    return initial
  }
  if (live) void loadOnce()

  const save = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (unsaved === null) return
    const state = unsaved
    unsaved = null
    void o.actions.saveState(state).catch(() => undefined)
  }

  const showTweaks = (): void => o.view.tweaks([...groups.values()])

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

  const applyTweak = (message: Extract<FrameMessage, { type: 'tweak' }>): void => {
    if (message.op === 'dispose') {
      groups.delete(message.id)
      showTweaks()
      return
    }
    if (groups.size >= INTELLIGENT_UI_TWEAK_GROUPS_MAX && !groups.has(message.group.id)) {
      showTweaks()
      return
    }
    /* label 是状态里 tweaks 的键：同 label 不同 id 的组会互相覆盖。外壳已校验，这里是第二道防线。 */
    const labelTaken = [...groups.values()].some(
      (group) => group.id !== message.group.id && group.label === message.group.label,
    )
    if (!labelTaken) groups.set(message.group.id, message.group)
    showTweaks()
  }

  const route = (message: FrameMessage): void => {
    switch (message.type) {
      case 'height':
        o.view.resize(message.height)
        return
      case 'state':
        current = { model: message.model, view: message.view, tweaks: message.tweaks }
        unsaved = current
        if (timer === null) timer = setTimeout(save, STATE_SAVE_DELAY_MS)
        return
      case 'tweak':
        applyTweak(message)
        return
      case 'error':
        o.view.fail(message.message)
        return
      case 'escape':
        o.view.escape?.()
        return
      default:
        act(message)
    }
  }

  port.onmessage = (event: MessageEvent) => {
    /* 预览期间只认 height；render 一旦投递（渲染可能还没回来）就放行其余消息 */
    if (disposed) return
    const message = parseFrameMessage(event.data)
    if (message === null) return
    if (!renderPosted && message.type !== 'height') return
    route(message)
  }

  const renderMessage = (state: IntelligentUiState | null) => {
    const { css, theme } = o.view.look()
    return { html: content.html, css, theme, bare: content.bare, wide: content.wide, state }
  }

  /* 先把读回的状态交出去；失败时回滚标记，让下一次 start/finish 还能再试 */
  const deliverRender = async (): Promise<void> => {
    try {
      const state = await loadOnce()
      if (disposed || rendered) return
      current = state ?? EMPTY_STATE
      const message = renderMessage(state)
      /* 先置位再投递：外壳回消息可能紧跟在投递之后，不能等投递返回才放行 */
      renderPosted = true
      if (channelHandedOff) port.postMessage({ type: 'render', ...message })
      else {
        o.view.deliver({ type: 'poietica:render', ...message }, [channel.port2])
        channelHandedOff = true
      }
      rendered = true
      if (!disposed) o.view.rendered()
    } catch (cause) {
      renderPosted = false
      rendered = false
      if (!disposed) o.view.fail(messageOf(cause))
    } finally {
      rendering = false
    }
  }

  /* 变成真界面：先读回状态，再交 render（第一次随端口一起交，预览过的走端口） */
  const goLive = (): void => {
    if (disposed || rendered || rendering) return
    rendering = true
    void deliverRender()
  }

  return {
    start() {
      if (disposed) return
      if (started) {
        if (live && !rendered && !rendering) goLive()
        return
      }
      started = true
      if (live) {
        goLive()
        return
      }
      const { css, theme } = o.view.look()
      try {
        o.view.deliver(
          {
            type: 'poietica:render',
            preview: true,
            html: content.html,
            css,
            theme,
            bare: content.bare,
            wide: content.wide,
          },
          [channel.port2],
        )
        channelHandedOff = true
      } catch (cause) {
        started = false
        o.view.fail(messageOf(cause))
      }
    },
    preview(html) {
      if (live || disposed || html === content.html) return
      content = { ...content, html }
      if (started) port.postMessage({ type: 'preview', html })
    },
    finish(next) {
      if (disposed || rendered) return
      if (live) {
        /* 第一次 finish 之后内容已经定了；这里只在投递失败后允许重试，不再接受第二版内容 */
        if (started && !rendering) goLive()
        return
      }
      live = true
      content = next
      void loadOnce()
      if (started) goLive()
    },
    retheme() {
      if (!started || disposed) return
      const { css, theme } = o.view.look()
      port.postMessage({ type: 'theme', css, theme })
    },
    setTweak(id, values) {
      const group = groups.get(id)
      if (group === undefined || disposed) return
      if (typeof values !== 'object' || values === null || Array.isArray(values)) return
      const given = values as Readonly<Record<string, unknown>>
      const next = { ...group.values }
      for (const control of group.controls) {
        if (Object.hasOwn(given, control.key))
          next[control.key] = coerceTweak(control, given[control.key]) ?? control.value
      }
      groups.set(id, { ...group, values: next })
      port.postMessage({ type: 'tweak.values', id, values: next })
      showTweaks()
    },
    state: () => current,
    dispose() {
      if (disposed) return
      disposed = true
      save()
      unsaved = null
      const hadGroups = groups.size > 0
      groups.clear()
      port.onmessage = null
      port.close()
      /* 组已清空；告诉卡片面板该收了，避免「iframe 没了但调整状态还开着」 */
      if (hadGroups) o.view.tweaks([])
    },
  }
}
