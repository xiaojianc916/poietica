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
import { useWorkspaceLayoutState, useWorkspaceLayoutStore } from '../shell/layout/layout-context'
import type { WorkbenchHost } from './runtime-contract'

const PANE_ICONS: Readonly<Record<AuxiliaryLauncherKind, ReactNode>> = {
  assistant: <MessageSquareText aria-hidden className="size-3.5 shrink-0 opacity-60" />,
  review: <FileDiff aria-hidden className="size-3.5 shrink-0 opacity-60" />,
  terminal: <SquareTerminal aria-hidden className="size-3.5 shrink-0 opacity-60" />,
  browser: <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />,
}

/* 文档格不在 catalog 里，所以它的字形不进上面那张表。 */
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
  /**
   * 这一格此刻归谁：对话是它的 threadId，设置页是设置自己那个键。
   *
   * 与 conversationId 分开：归属决定这一格装的是什么（各归属互不串门），而 conversationId
   * 只是正文里那几个通道要问的那条对话 —— 设置页开着时它仍可能指着某条对话。
   */
  readonly owner: string | null
  /** 浏览器那一段算不算这一格的。设置页那一格不算：别处打开的标签页不该跟进来。 */
  readonly ownsBrowser: boolean
  /** 面板所属的对话，不随隐藏期间的活动标签切换。 */
  readonly conversationId: string | null
  /** 这一格在不在场。与外壳的停靠位读同一个布尔。 */
  readonly isDocked: boolean
  /** 文档格要看的技能名册，与设置页读的是同一份快照。 */
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
  const layout = useWorkspaceLayoutState()
  const layoutStore = useWorkspaceLayoutStore()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  useEffect(() => {
    store.setOwner(owner, ownsBrowser)
  }, [owner, ownsBrowser, store.setOwner])

  useEffect(() => {
    store.setVisible(isDocked && state.focus.kind === 'browser')
  }, [isDocked, state.focus, store.setVisible])

  /* 加号菜单只列这一格装得下的通道：不认领浏览器时，那一项不出现。 */
  const paneOffers = useMemo(
    () => (ownsBrowser ? PANE_OFFERS : PANE_OFFERS.filter((offer) => offer.kind !== 'browser')),
    [ownsBrowser],
  )

  /* 每种通道一个渲染器：委派通道归 agent-ui，审查归 review。空态归 AuxiliaryPanel。 */
  const paneName = useDelegateChannelNames(conversationId)

  const terminalRoot = useConversationWorkspaceRoot(conversationId)

  /* 文档格只认资源号，正文按名册里的那一份查 —— 打开之后名册变了也不回盘上再读。 */
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
      fullscreen={layout.auxiliaryFullscreen}
      layoutSignal={layout}
      onToggleFullscreen={layoutStore.toggleAuxiliaryFullscreen}
      paneOffers={paneOffers}
      panes={panes}
      store={store}
    />
  )
}
