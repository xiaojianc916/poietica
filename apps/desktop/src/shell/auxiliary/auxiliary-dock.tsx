import {
  DelegateChannelIcon,
  DelegateChannelPane,
  useDelegateChannelNames,
} from '@poietica/assistant'
import type { AuxiliaryPaneOffer } from '@poietica/auxiliary/panel'
import {
  AUXILIARY_LAUNCHER,
  type AuxiliaryLauncherKind,
  AuxiliaryPanel,
  type AuxiliaryPanelStore,
  type AuxiliaryPaneRenderers,
} from '@poietica/auxiliary/panel'
import { terminalHostPort } from '@poietica/native-bridge'
import { warn } from '@poietica/problem'
import { FileDiff, Globe, MessageSquareText, PanelRight, SquareTerminal } from 'lucide-react'
import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import { useConversationWorkspaceRoot } from '../../assistant/threads-context'
import { useWorkspaceLayoutState, workspaceLayoutStore } from '../workspace-layout-store'

/*
 * 辅助面板开关与停靠位。
 *
 * 开合与宽度归 workspaceLayoutStore（外壳区域的几何，与侧栏同一台状态机）；
 * 标签与页面归 store（宿主快照的投影）。这里是唯一把两者合成为
 * 「原生 webview 该不该可见」的地方 —— 否则「谁隐藏了 webview」就有两个答案。
 */

const PANE_ICONS: Readonly<Record<AuxiliaryLauncherKind, ReactNode>> = {
  assistant: <MessageSquareText aria-hidden className="size-3.5 shrink-0 opacity-60" />,
  review: <FileDiff aria-hidden className="size-3.5 shrink-0 opacity-60" />,
  terminal: <SquareTerminal aria-hidden className="size-3.5 shrink-0 opacity-60" />,
  browser: <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />,
}

const PANE_OFFERS: readonly AuxiliaryPaneOffer[] = AUXILIARY_LAUNCHER.map((entry) => ({
  ...entry,
  icon: PANE_ICONS[entry.kind],
}))

const DeferredReviewPane = lazy(() =>
  import('../../assistant/review-pane').then(({ ConversationReviewPane }) => ({
    default: ConversationReviewPane,
  })),
)
const DeferredTerminalPane = lazy(() =>
  import('../../assistant/terminal-pane').then(({ ConversationTerminalPane }) => ({
    default: ConversationTerminalPane,
  })),
)

function releaseTerminal(root: string | null): void {
  if (root === null) {
    return
  }
  void terminalHostPort.close(root).catch((cause: unknown) => {
    warn('终端会话没能关掉', { cause, scope: 'terminal' })
  })
}

interface AuxiliaryDockProps {
  readonly store: AuxiliaryPanelStore
  /** 屏幕上这一刻的那条对话；不在对话里（设置、别的表面）就是 null。 */
  readonly conversationId: string | null
  /** 这一格在不在场。与外壳的停靠位读同一个布尔。 */
  readonly isDocked: boolean
}

export function AuxiliaryDock({ conversationId, isDocked, store }: AuxiliaryDockProps) {
  const layout = useWorkspaceLayoutState()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  /* 手动关过就静音，手动开恢复。会话内状态，不落盘。 */
  const muted = useRef(false)
  const busy = useRef(false)
  const wasHeld = useRef(layout.auxiliaryThread !== null)

  useEffect(() => store.start(), [store])

  useEffect(() => {
    /* 只读通道在场、或菜单浮层展开时，原生 webview 必须让位给 HTML。 */
    store.setVisible(isDocked && state.focus.kind === 'browser' && state.openMenu === null)
  }, [isDocked, state.focus, state.openMenu, store.setVisible])

  useEffect(() => {
    const held = layout.auxiliaryThread !== null

    if (held !== wasHeld.current) {
      muted.current = wasHeld.current
      wasHeld.current = held
    }
  }, [layout.auxiliaryThread])

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
      layout.auxiliaryThread === null &&
      conversationId !== null
    ) {
      workspaceLayoutStore.setAuxiliaryThread(conversationId)
    }

    busy.current = loading
  }, [state.host, layout.auxiliaryThread, conversationId])

  /* 每种通道一个渲染器：委派通道归 agent-ui，审查归 review。空态归 AuxiliaryPanel。 */
  const paneName = useDelegateChannelNames(conversationId)

  const terminalRoot = useConversationWorkspaceRoot(conversationId)

  const panes = useMemo<AuxiliaryPaneRenderers>(
    () => ({
      delegate: {
        body: (id) =>
          conversationId === null ? null : (
            <DelegateChannelPane agentId={id} conversationId={conversationId} />
          ),
        icon: <DelegateChannelIcon />,
        name: paneName,
        release: () => undefined,
      },
      assistant: {
        body: () => <p className="p-4 text-xs text-muted-foreground">辅助对话尚未实现。</p>,
        icon: <PanelRight aria-hidden className="size-3.5" />,
        name: () => '辅助对话',
        release: () => undefined,
      },
      terminal: {
        body: () => (
          <Suspense fallback={<p className="p-4 text-xs opacity-50">正在加载终端…</p>}>
            <DeferredTerminalPane conversationId={conversationId} />
          </Suspense>
        ),
        icon: PANE_ICONS.terminal,
        name: () => '终端',
        release: () => {
          releaseTerminal(terminalRoot)
        },
      },
      review: {
        body: () => (
          <Suspense fallback={<p className="p-4 text-xs opacity-50">正在加载审查…</p>}>
            <DeferredReviewPane conversationId={conversationId} />
          </Suspense>
        ),
        icon: PANE_ICONS.review,
        name: () => '审查',
        release: () => undefined,
      },
    }),
    [conversationId, paneName, terminalRoot],
  )

  return (
    <AuxiliaryPanel layoutSignal={layout} paneOffers={PANE_OFFERS} panes={panes} store={store} />
  )
}
