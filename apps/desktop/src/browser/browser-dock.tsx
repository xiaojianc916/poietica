import { BrowserPanel } from '@poietica/browser'
import { PanelRight } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'

import { browserPanelStore } from './browser-runtime'

/*
 * 对话表面右上角的开关，与右侧的浏览器 dock。
 *
 * 开合状态活在 browserPanelStore（一份，跨表面切换不丢）；这里只投影。
 * 原生 webview 的可见性由 store 合成（open 且 surfaceActive），组件不直接
 * 碰宿主 —— 否则「谁隐藏了 webview」就有两个答案。
 */

export function BrowserPanelToggle() {
  const state = useSyncExternalStore(
    browserPanelStore.subscribe,
    browserPanelStore.getSnapshot,
    browserPanelStore.getSnapshot,
  )

  const label = state.open ? '收起浏览器' : '打开浏览器'

  return (
    <button
      aria-label={label}
      aria-pressed={state.open}
      className="absolute right-3 top-3 z-10 flex size-7 items-center justify-center rounded-md border border-current/15 bg-[Canvas] opacity-60 hover:opacity-100"
      onClick={browserPanelStore.togglePanel}
      title={label}
      type="button"
    >
      <PanelRight aria-hidden className="size-4" />
    </button>
  )
}

export function BrowserDock({ surfaceActive }: { readonly surfaceActive: boolean }) {
  const state = useSyncExternalStore(
    browserPanelStore.subscribe,
    browserPanelStore.getSnapshot,
    browserPanelStore.getSnapshot,
  )

  /* start() 幂等且不持有订阅，effect 没有东西要清理 —— 与 PluginLoader 同款。 */
  useEffect(() => {
    browserPanelStore.start()
  }, [])

  useEffect(() => {
    browserPanelStore.setSurfaceActive(surfaceActive)
  }, [surfaceActive])

  if (!surfaceActive || !state.open) {
    return null
  }

  return <BrowserPanel store={browserPanelStore} />
}
