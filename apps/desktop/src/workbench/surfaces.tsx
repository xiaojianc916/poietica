import type { AutomationStore } from '@poietica/automation'
import type { AgentSessionPort, ComposerDrafts } from '@poietica/conversation'
import { ComposerDraftsContext, useAgentControls } from '@poietica/conversation/surface'
import type { PersonalizationStore } from '@poietica/settings'
import { lazy, type ReactNode, Suspense } from 'react'
import { AssistantPane } from '../assistant/assistant-pane'
import type { SurfaceRenderers } from '../shell/surfaces/surface'
import type { WorkbenchHost } from './runtime-contract'

const DeferredAutomationsSurface = lazy(() =>
  import('@poietica/automation/ui').then(({ AutomationsSurface }) => ({
    default: AutomationsSurface,
  })),
)
const DeferredPersonalizationSurface = lazy(() =>
  import('@poietica/settings/ui').then(({ PersonalizationSurface }) => ({
    default: PersonalizationSurface,
  })),
)
function SurfaceLoading() {
  return <p className="p-4 text-xs text-muted-foreground">正在加载…</p>
}

/**
 * AI 表面只有一个渲染出口。入口与真实对话只改变 threadId，依赖与 React 身份不换轨。
 */
interface DesktopSurfaces {
  /** 工作区表面插槽：注册表里每一条 surface 都要在这里交出渲染器。 */
  readonly surfaces: SurfaceRenderers
  /** 新入口与真实对话共用这一条渲染管线。 */
  readonly renderAssistant: (threadId?: string) => ReactNode
}

interface DesktopSurfacesOptions {
  readonly pickWorkspace: WorkbenchHost['pickWorkspace']
  readonly drafts: ComposerDrafts
  readonly personalization: PersonalizationStore
  /** 资料库表面是桌面领域，由组合根注入，工作台领域不认它。 */
  readonly library: () => ReactNode
  /** 分叉出的对话开出来之后，去它那里 —— 与打开一条对话同一个动作。 */
  readonly onConversationForked: (threadId: string, title: string) => void
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  readonly automationStore: AutomationStore
}

export function createDesktopSurfaces({
  pickWorkspace,
  automationStore,
  drafts,
  personalization,
  library,
  onConversationForked,
  onConversationStarted,
  session,
}: DesktopSurfacesOptions): DesktopSurfaces {
  const renderAssistant = (threadId?: string): ReactNode => (
    <ComposerDraftsContext value={drafts}>
      <AssistantPane
        onConversationForked={onConversationForked}
        onConversationStarted={onConversationStarted}
        session={session}
        threadId={threadId}
      />
    </ComposerDraftsContext>
  )

  return {
    surfaces: {
      ai: () => renderAssistant(),

      automations: () => (
        <Suspense fallback={<SurfaceLoading />}>
          <AutomationsView
            onOpenThread={onConversationStarted}
            pickWorkspace={pickWorkspace}
            store={automationStore}
          />
        </Suspense>
      ),

      personalization: () => (
        <Suspense fallback={<SurfaceLoading />}>
          <DeferredPersonalizationSurface store={personalization} />
        </Suspense>
      ),
      library: () => library(),
    },

    renderAssistant,
  }
}

interface AutomationsViewProps {
  readonly pickWorkspace: WorkbenchHost['pickWorkspace']
  readonly store: AutomationStore
  readonly onOpenThread: (threadId: string, title: string) => void
}
function AutomationsView({ store, onOpenThread, pickWorkspace }: AutomationsViewProps) {
  const { controls } = useAgentControls()
  return (
    <DeferredAutomationsSurface
      controls={controls}
      defaultTimeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      onOpenThread={onOpenThread}
      pickWorkspace={pickWorkspace}
      store={store}
    />
  )
}
