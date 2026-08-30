import type { AgentSessionPort } from '@poietica/conversation'
import { ComposerDrafts, ComposerDraftsContext, useAgentControls } from '@poietica/conversation-ui'
import { PluginsSurface } from '@poietica/extension-ui'
import { type CustomAgentStore, PersonalizationStore } from '@poietica/settings'
import { PersonalizationSurface } from '@poietica/settings-ui'
import type { ReactNode } from 'react'
import { AutomationsView } from '../automations/automations-view'
import { pluginStore } from '../plugins/plugin-runtime'
import type { SurfaceRenderers } from '../shell/surface'
import { AssistantPane } from './assistant-pane'

/**
 * AI 表面只有一个渲染出口。入口与真实对话只改变 threadId，依赖与 React 身份不换轨。
 */
interface AssistantWiring {
  /** 工作区表面插槽：注册表里每一条 surface 都要在这里交出渲染器。 */
  readonly surfaces: SurfaceRenderers
  /** 新入口与真实对话共用这一条渲染管线。 */
  readonly renderAssistant: (threadId?: string) => ReactNode
}

/*
 * 用哪一家 agent 不从这里过。
 *
 * 能力表的接线落在组合根（见 shell/app-shell.tsx），于是这条链上没有一个渲染器
 * 需要认识 agentId 或那份配置。此前它们一路当 prop 往下递，四层里有三层只是原样
 * 转手，终点那一格拿去在 effect 里接一次线 —— 而那根线本来就不该从渲染树上走。
 */
interface AssistantWiringOptions {
  readonly customAgents: CustomAgentStore
  /** 分叉出的对话开出来之后，去它那里 —— 与打开一条对话同一个动作。 */
  readonly onConversationForked: (threadId: string, title: string) => void
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
}

/*
 * 扩展页在这里接上名册：技能表是 kap 名册的投影（见 @poietica/extension 的 skill.ts），
 * 名册唯一持有者是能力表 store，经 Context 读它交进去，不复制。
 */
function ToolsSurface() {
  const { toolkit } = useAgentControls()

  return <PluginsSurface roster={toolkit.skills} store={pluginStore} />
}

export function createAssistantWiring({
  customAgents,
  onConversationForked,
  onConversationStarted,
  session,
}: AssistantWiringOptions): AssistantWiring {
  /*
   * 离屏草稿的册子。它活得和这份接线一样长 —— 也就是这次运行 —— 所以切标签
   * 页不丢字，重启之后本来就该是空的。两个入口共用这一本。
   */
  const drafts = new ComposerDrafts()

  /* 子 Agent 目录的唯一真相，寿命与这份接线相同：离开这一格再回来，草稿与选中项还在。 */
  const personalization = new PersonalizationStore(customAgents)

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

      /*
       * 自动化那一格。渲染器现在是全域 Record（见 app shell 的 surface.ts）：
       * 注册表里登记了 automations，这里就必须交出一条，
       * 漏掉是编译错误而不是一张空态图。
       */
      automations: () => <AutomationsView />,

      /* Tool 那一格。注册表里 tools 已经是 surface，漏掉这一条是编译错误。 */
      personalization: () => <PersonalizationSurface store={personalization} />,
      tools: () => <ToolsSurface />,
    },

    renderAssistant,
  }
}
