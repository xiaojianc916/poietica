import {
  DelegateChannelIcon,
  DelegateChannelPane,
  useDelegateChannelNames,
} from '@poietica/agent-ui'
import { BrowserPanel, type DockPaneOffer, type DockPaneRenderers } from '@poietica/browser'
import { useWorkspaceLayoutState, workspaceLayoutStore } from '@poietica/workspace'
import { GitBranch, PanelRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

import { ReviewPane } from '../review/review-pane'
import { browserPanelStore } from './browser-runtime'

/*
 * 浏览器开关与浏览器 dock。
 *
 * 开合与宽度归 workspaceLayoutStore（外壳区域的几何，与侧栏同一台状态机）；
 * 标签与页面归 browserPanelStore（宿主快照的投影）。这里是唯一把两者合成为
 * 「原生 webview 该不该可见」的地方 —— 否则「谁隐藏了 webview」就有两个答案。
 */

/* 加号菜单能开的通道。网页那一行不在这张表里：它是宿主自带的那一格。 */
const PANE_OFFERS: readonly DockPaneOffer[] = [{ kind: 'review', label: '审查' }]

export function BrowserPanelToggle({ conversationId }: { readonly conversationId: string }) {
  const { browserThread } = useWorkspaceLayoutState()
  const held = browserThread === conversationId
  const label = held ? '收起浏览器' : '打开浏览器'

  return (
    <button
      aria-label={label}
      aria-pressed={held}
      className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-current/10 hover:opacity-100"
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

interface BrowserDockProps {
  /** 屏幕上这一刻的那条对话；不在对话里（设置、别的表面）就是 null。 */
  readonly conversationId: string | null
  /** 这一格在不在场。与外壳的停靠位读同一个布尔。 */
  readonly isDocked: boolean
}

export function BrowserDock({ conversationId, isDocked }: BrowserDockProps) {
  const layout = useWorkspaceLayoutState()
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
    /* 只读通道在场、或菜单浮层展开时，原生 webview 必须让位给 HTML。 */
    browserPanelStore.setVisible(isDocked && state.activePaneId === null && state.openMenu === null)
  }, [isDocked, state.activePaneId, state.openMenu])

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

  /* 每种通道一个渲染器：委派通道归 agent-ui，审查归 review。空态归 BrowserPanel。 */
  const paneName = useDelegateChannelNames(conversationId)

  const panes = useMemo<DockPaneRenderers>(
    () => ({
      delegate: {
        body: (id) =>
          conversationId === null ? null : (
            <DelegateChannelPane agentId={id} conversationId={conversationId} />
          ),
        icon: <DelegateChannelIcon />,
        name: paneName,
      },
      review: {
        body: () => <ReviewPane conversationId={conversationId} />,
        icon: <GitBranch aria-hidden className="size-3.5 shrink-0 opacity-60" />,
        name: () => '审查',
      },
    }),
    [conversationId, paneName],
  )

  return (
    <BrowserPanel
      layoutSignal={layout}
      paneOffers={PANE_OFFERS}
      panes={panes}
      store={browserPanelStore}
      trailing={
        conversationId === null ? null : <BrowserPanelToggle conversationId={conversationId} />
      }
    />
  )
}
