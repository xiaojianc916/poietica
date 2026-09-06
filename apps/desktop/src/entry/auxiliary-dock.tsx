import {
  DelegateChannelIcon,
  DelegateChannelPane,
  useDelegateChannelNames,
} from '@poietica/conversation/surface'
import { terminalHostPort } from '@poietica/native-bridge/terminal'
import { warn } from '@poietica/problem'
import type { AuxiliaryPaneOffer } from '@poietica/workspace/panels'
import {
  AUXILIARY_LAUNCHER,
  type AuxiliaryLauncherKind,
  AuxiliaryPanel,
  type AuxiliaryPanelStore,
  type AuxiliaryPaneRenderers,
} from '@poietica/workspace/panels'
import { FileDiff, Globe, MessageSquareText, PanelRight, SquareTerminal } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useConversationWorkspaceRoot } from '../assistant/threads-context'
import { useWorkspaceLayoutState } from '../shell/layout/layout-context'

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
  import('./review-pane').then(({ ConversationReviewPane }) => ({
    default: ConversationReviewPane,
  })),
)
const DeferredTerminalPane = lazy(() =>
  import('./terminal-pane').then(({ ConversationTerminalPane }) => ({
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
  /** 面板所属的对话，不随隐藏期间的活动标签切换。 */
  readonly conversationId: string | null
  /** 这一格在不在场。与外壳的停靠位读同一个布尔。 */
  readonly isDocked: boolean
}

export function AuxiliaryDock({ conversationId, isDocked, store }: AuxiliaryDockProps) {
  const layout = useWorkspaceLayoutState()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  useEffect(() => {
    store.setVisible(isDocked && state.focus.kind === 'browser')
  }, [isDocked, state.focus, store.setVisible])

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
