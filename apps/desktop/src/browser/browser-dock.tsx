import { BrowserPanel } from '@poietica/browser'
import { workspaceLayoutStore } from '@poietica/workspace'
import { PanelRight } from 'lucide-react'
import { useEffect, useRef, useSyncExternalStore } from 'react'

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

export function BrowserPanelToggle() {
  const { browserOpen } = useLayout()
  const label = browserOpen ? '收起浏览器' : '打开浏览器'

  return (
    <button
      aria-label={label}
      aria-pressed={browserOpen}
      className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 aria-pressed:bg-current/10 aria-pressed:opacity-100 hover:bg-current/10 hover:opacity-100"
      onClick={workspaceLayoutStore.toggleBrowser}
      title={label}
      type="button"
    >
      <PanelRight aria-hidden className="size-4" />
    </button>
  )
}

export function BrowserDock({ surfaceActive }: { readonly surfaceActive: boolean }) {
  const layout = useLayout()
  const state = useSyncExternalStore(
    browserPanelStore.subscribe,
    browserPanelStore.getSnapshot,
    browserPanelStore.getSnapshot,
  )

  /* 手动关过就静音，手动开恢复。会话内状态，不落盘。 */
  const muted = useRef(false)
  const busy = useRef(false)
  const wasOpen = useRef(layout.browserOpen)

  /* start() 幂等且不持有订阅，effect 没有东西要清理。 */
  useEffect(() => {
    browserPanelStore.start()
  }, [])

  useEffect(() => {
    /* 浮层开着时原生 webview 让位：它是独立窗口，永远压过主窗口的 HTML 弹窗。 */
    browserPanelStore.setVisible(layout.browserOpen && surfaceActive && !state.overlayOpen)
  }, [layout.browserOpen, surfaceActive, state.overlayOpen])

  useEffect(() => {
    if (layout.browserOpen !== wasOpen.current) {
      muted.current = wasOpen.current
      wasOpen.current = layout.browserOpen
    }
  }, [layout.browserOpen])

  /*
   * agent 在后台驱动浏览器时把面板亮出来：看「有地址的标签在装载」的 0→1 边沿。
   * 空白页（url 缺席）不算忙 —— 预热不该弹面板。
   */
  useEffect(() => {
    const loading = state.host?.tabs.some((tab) => tab.loading && tab.url !== null) ?? false

    if (loading && !busy.current && !layout.browserOpen && !muted.current) {
      workspaceLayoutStore.setBrowserOpen(true)
    }

    busy.current = loading
  }, [state.host, layout.browserOpen])

  if (state.host === null) {
    /* 快照还没到或宿主没接上：如实说，不画一个假浏览器。 */
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-8 items-center justify-end border-b border-current/10 pr-2.5">
          <BrowserPanelToggle />
        </div>
        <p className="p-4 text-xs opacity-50">浏览器宿主没有回应。</p>
      </div>
    )
  }

  return (
    <BrowserPanel
      layoutSignal={layout}
      store={browserPanelStore}
      trailing={<BrowserPanelToggle />}
    />
  )
}
