import { DelegateChannelPane, DelegateChannelTab } from '@poietica/agent-ui'
import { BrowserPanel, type DockPaneRenderers } from '@poietica/browser'
import { workspaceLayoutStore } from '@poietica/workspace'
import { PanelRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

import { browserPanelStore } from './browser-runtime'

/*
 * 浏览器开关与浏览器 dock。
 *
 * 开合与宽度归 workspaceLayoutStore（外壳区域的几何，与侧栏同一台状态机）；
 * 标签与页面归 browserPanelStore（宿主快照的投影）。这里是唯一把两者合成为
 * 「原生 webview 该不该可见」的地方 —— 否则「谁隐藏了 webview」就有两个答案。
 */

function useLayout() {
  return useSyncExternalStore(
    workspaceLayoutStore.subscribe,
    workspaceLayoutStore.getSnapshot,
    workspaceLayoutStore.getSnapshot,
  )
}

export function BrowserPanelToggle({ conversationId }: { readonly conversationId: string }) {
  const { browserThread } = useLayout()
  const held = browserThread === conversationId
  const label = held ? '收起浏览器' : '打开浏览器'

  return (
    <button
      aria-label={label}
      aria-pressed={held}
      className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 aria-pressed:bg-current/10 aria-pressed:opacity-100 hover:bg-current/10 hover:opacity-100"
      onClick={() => {
        workspaceLayoutStore.setBrowserThread(held ? null : conversationId)
      }}
      title={label}
      type="button"
    >
      <PanelRight aria-hidden className="size-4" />
    </button>
  )
}

export interface BrowserDockProps {
  /** 屏幕上这一刻的那条对话；不在对话里（设置、别的表面）就是 null。 */
  readonly conversationId: string | null
  /** 这一格在不在场。与外壳的停靠位读同一个布尔。 */
  readonly isDocked: boolean
}

export function BrowserDock({ conversationId, isDocked }: BrowserDockProps) {
  const layout = useLayout()
  const state = useSyncExternalStore(
    browserPanelStore.subscribe,
    browserPanelStore.getSnapshot,
    browserPanelStore.getSnapshot,
  )

  /* 手动关过就静音，手动开恢复。会话内状态，不落盘。 */
  const muted = useRef(false)
  const busy = useRef(false)
  const wasHeld = useRef(layout.browserThread !== null)

  /* start() 幂等且不持有订阅，effect 没有东西要清理。 */
  useEffect(() => {
    browserPanelStore.start()
  }, [])

  useEffect(() => {
    /* 原生 webview 是独立窗口，永远压过主窗口的 HTML：浮层开着、或屏幕上是一条
       只读通道时，它必须让位。 */
    browserPanelStore.setVisible(isDocked && !state.overlayOpen && state.activePaneId === null)
  }, [isDocked, state.activePaneId, state.overlayOpen])

  useEffect(() => {
    const held = layout.browserThread !== null

    if (held !== wasHeld.current) {
      muted.current = wasHeld.current
      wasHeld.current = held
    }
  }, [layout.browserThread])

  /*
   * agent 在后台驱动浏览器时把面板亮出来：看「有地址的标签在装载」的 0→1 边沿。
   * 空白页（url 缺席）不算忙 —— 预热不该弹面板。已经归属某条对话时
   * 不抢：那条对话回到屏幕上时它自然在场，别的对话不该被弹出一个浏览器。
   */
  useEffect(() => {
    const loading = state.host?.tabs.some((tab) => tab.loading && tab.url !== null) ?? false

    if (
      loading &&
      !busy.current &&
      !muted.current &&
      layout.browserThread === null &&
      conversationId !== null
    ) {
      workspaceLayoutStore.setBrowserThread(conversationId)
    }

    busy.current = loading
  }, [state.host, layout.browserThread, conversationId])

  /* 通道内容由 agent-ui 画：本格只管把它摆进 dock。宿主哑掉的空态归 BrowserPanel。 */
  const panes = useMemo<DockPaneRenderers>(
    () => ({
      tab: (id) =>
        conversationId === null ? null : (
          <DelegateChannelTab conversationId={conversationId} toolCallId={id} />
        ),
      body: (id) =>
        conversationId === null ? null : (
          <DelegateChannelPane conversationId={conversationId} toolCallId={id} />
        ),
    }),
    [conversationId],
  )

  return (
    <BrowserPanel
      layoutSignal={layout}
      panes={panes}
      store={browserPanelStore}
      trailing={
        conversationId === null ? null : <BrowserPanelToggle conversationId={conversationId} />
      }
    />
  )
}
