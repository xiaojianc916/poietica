import type { AgentSkill } from '@poietica/conversation'
import {
  AuxiliaryComposer,
  DelegateChannelIcon,
  DelegateChannelPane,
  useDelegateChannelNames,
} from '@poietica/conversation/surface'
import { LoadingState } from '@poietica/design-system'
import { skillRows } from '@poietica/extension'
import { warn } from '@poietica/problem'
import type { AuxiliaryPaneOffer } from '@poietica/workspace/panels'
import {
  AUXILIARY_LAUNCHER,
  type AuxiliaryLauncherKind,
  AuxiliaryPanel,
  type AuxiliaryPanelStore,
  type AuxiliaryPaneRenderers,
} from '@poietica/workspace/panels'
import {
  FileDiff,
  FileText,
  Globe,
  MessageSquareText,
  PanelRight,
  SquareTerminal,
} from 'lucide-react'
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useConversationWorkspaceRoot } from '../assistant/threads-context'
import { useWorkspaceLayoutStore, useWorkspaceLayoutValue } from '../shell/layout/layout-context'
import type { WorkbenchHost } from './runtime-contract'

const PANE_ICONS: Readonly<Record<AuxiliaryLauncherKind, ReactNode>> = {
  assistant: <MessageSquareText aria-hidden className="size-3.5 shrink-0 opacity-60" />,
  review: <FileDiff aria-hidden className="size-3.5 shrink-0 opacity-60" />,
  terminal: <SquareTerminal aria-hidden className="size-3.5 shrink-0 opacity-60" />,
  browser: <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />,
}

const DOCUMENT_PANE_ICON = <FileText aria-hidden className="size-3.5 shrink-0 opacity-60" />

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
const DeferredSkillDocumentPane = lazy(() =>
  import('./skill-document-pane').then(({ SkillDocumentPane }) => ({
    default: SkillDocumentPane,
  })),
)

function releaseTerminal(port: WorkbenchHost['terminal'], root: string | null): void {
  if (root === null) {
    return
  }
  void port.close(root).catch((cause: unknown) => {
    warn('终端会话没能关掉', { cause, scope: 'terminal' })
  })
}

interface AuxiliaryDockProps {
  readonly host: Pick<WorkbenchHost, 'review' | 'terminal'>
  readonly store: AuxiliaryPanelStore
  readonly owner: string | null
  readonly ownsBrowser: boolean
  readonly conversationId: string | null
  readonly isDocked: boolean
  readonly skills: readonly AgentSkill[]
}

export function AuxiliaryDock({
  conversationId,
  isDocked,
  owner,
  ownsBrowser,
  skills,
  store,
  host,
}: AuxiliaryDockProps) {
  const layoutGeometry = useWorkspaceLayoutValue(
    (state) =>
      `${String(state.sidebarOpen)}:${state.sidebarWidth}:${state.auxiliaryWidth}:${String(state.auxiliaryFullscreen)}`,
  )
  const auxiliaryFullscreen = useWorkspaceLayoutValue((state) => state.auxiliaryFullscreen)
  const layoutSignal = useMemo(() => ({ layoutGeometry }), [layoutGeometry])
  const layoutStore = useWorkspaceLayoutStore()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  useEffect(() => {
    store.setOwner(owner, ownsBrowser)
  }, [owner, ownsBrowser, store.setOwner])

  useEffect(() => {
    store.setVisible(isDocked && state.focus.kind === 'browser')
  }, [isDocked, state.focus, store.setVisible])

  const paneOffers = useMemo(
    () => (ownsBrowser ? PANE_OFFERS : PANE_OFFERS.filter((offer) => offer.kind !== 'browser')),
    [ownsBrowser],
  )

  const paneName = useDelegateChannelNames(conversationId)

  const terminalRoot = useConversationWorkspaceRoot(conversationId)

  const documents = useMemo(() => new Map(skillRows(skills).map((row) => [row.key, row])), [skills])

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
        body: () => <AuxiliaryComposer />,
        icon: <PanelRight aria-hidden className="size-3.5" />,
        name: () => '辅助对话',
        release: () => undefined,
      },
      terminal: {
        body: () => (
          <Suspense fallback={<LoadingState label="Loading..." />}>
            <DeferredTerminalPane conversationId={conversationId} port={host.terminal} />
          </Suspense>
        ),
        icon: PANE_ICONS.terminal,
        name: () => '终端',
        release: () => {
          releaseTerminal(host.terminal, terminalRoot)
        },
      },
      review: {
        body: () => (
          <Suspense fallback={<LoadingState label="Loading..." />}>
            <DeferredReviewPane conversationId={conversationId} gateway={host.review} />
          </Suspense>
        ),
        icon: PANE_ICONS.review,
        name: () => '审查',
        release: () => undefined,
      },
      file: {
        body: (id) => (
          <Suspense fallback={<LoadingState label="Loading..." />}>
            <DeferredSkillDocumentPane skill={documents.get(id)} />
          </Suspense>
        ),
        icon: DOCUMENT_PANE_ICON,
        name: (id) => documents.get(id)?.name ?? 'SKILL.md',
        release: () => undefined,
      },
    }),
    [conversationId, documents, host.review, host.terminal, paneName, terminalRoot],
  )

  return (
    <AuxiliaryPanel
      fullscreen={auxiliaryFullscreen}
      layoutSignal={layoutSignal}
      onToggleFullscreen={layoutStore.toggleAuxiliaryFullscreen}
      paneOffers={paneOffers}
      panes={panes}
      store={store}
    />
  )
}
