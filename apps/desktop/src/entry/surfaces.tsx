import type { AutomationStore } from '@poietica/automation'
import type { AgentSessionPort, ComposerDrafts } from '@poietica/conversation'
import { ComposerDraftsContext, useAgentControls } from '@poietica/conversation/surface'
import type { PluginStore } from '@poietica/extension'
import { pickWorkspaceRoot } from '@poietica/native-bridge/workspace'
import type { PersonalizationStore } from '@poietica/settings'

import { lazy, type ReactNode, Suspense } from 'react'
import { AssistantPane } from '../assistant/assistant-pane'
import type { SurfaceRenderers } from '../shell/surfaces/surface'

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
const DeferredPluginsSurface = lazy(() =>
  import('@poietica/extension/ui').then(({ PluginsSurface }) => ({ default: PluginsSurface })),
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
  readonly drafts: ComposerDrafts
  readonly personalization: PersonalizationStore
  /** 分叉出的对话开出来之后，去它那里 —— 与打开一条对话同一个动作。 */
  readonly onConversationForked: (threadId: string, title: string) => void
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  /** 进程级自动化表与插件名册，由组合根构造注入（见 entry/compose-runtime.ts）。 */
  readonly automationStore: AutomationStore
  readonly pluginStore: PluginStore
}

function ToolsSurface({ store }: { store: PluginStore }) {
  const { toolkit } = useAgentControls()

  return (
    <Suspense fallback={<SurfaceLoading />}>
      <DeferredPluginsSurface roster={toolkit.skills} store={store} />
    </Suspense>
  )
}

export function createDesktopSurfaces({
  automationStore,
  drafts,
  personalization,
  onConversationForked,
  onConversationStarted,
  pluginStore,
  session,
}: DesktopSurfacesOptions): DesktopSurfaces {
  /* 子 Agent 目录的唯一真相，寿命与这份接线相同：离开这一格再回来，草稿与选中项还在。 */

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
          <AutomationsView onOpenThread={onConversationStarted} store={automationStore} />
        </Suspense>
      ),

      /* Tool 那一格。注册表里 tools 已经是 surface，漏掉这一条是编译错误。 */
      personalization: () => (
        <Suspense fallback={<SurfaceLoading />}>
          <DeferredPersonalizationSurface store={personalization} />
        </Suspense>
      ),
      tools: () => <ToolsSurface store={pluginStore} />,
    },

    renderAssistant,
  }
}

interface AutomationsViewProps {
  readonly store: AutomationStore
  readonly onOpenThread: (threadId: string, title: string) => void
}
function AutomationsView({ store, onOpenThread }: AutomationsViewProps) {
  const { controls } = useAgentControls()
  return (
    <DeferredAutomationsSurface
      controls={controls}
      defaultTimeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      onOpenThread={onOpenThread}
      pickWorkspace={pickWorkspaceRoot}
      store={store}
    />
  )
}
