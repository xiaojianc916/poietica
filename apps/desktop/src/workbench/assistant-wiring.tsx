import type { AgentSessionPort } from '@poietica/agent-contract'
import { PluginsSurface } from '@poietica/plugins'
import type { SurfaceRenderers } from '@poietica/workspace'
import type { ReactNode } from 'react'
import { AutomationsView } from '../automations/automations-view'
import { pluginStore } from '../plugins/plugin-runtime'
import { AssistantPane } from './assistant-pane'
import { ConversationSurface } from './conversation-surface'

/**
 * AI 接入工作区的全部接线。
 *
 * packages/workspace 只认识插槽和 surface 种类,agent 那边只认识会话端口,
 * 两者互不认识;会话端口在这里、且只在这里交出去。
 *
 * 为什么是「全部」而不只是表面插槽:助手界面有两个入口 —— AI 那一格
 * (AssistantPane),以及一条对话被提升成标签页之后的 ConversationSurface。
 * 两者要的是同一对依赖,所以依赖只从这一个口子出去:再多一个入口也必须落在这个
 * 文件,漏不掉。
 *
 * 「这一格变成了一条对话」是两边的交界事实,所以也从这里传进去。
 *
 * 对面那家 agent 的方言不在这里:它是一个进程一份的事实,和会话列表同级,
 * 落在 apps/desktop/src/shell/app-shell.tsx。
 */
export interface AssistantWiring {
  /** 工作区表面插槽：注册表里每一条 surface 都要在这里交出渲染器。 */
  readonly surfaces: SurfaceRenderers
  /** 一条对话占住整个标签页时的样子。 */
  readonly renderConversation: (threadId: string) => ReactNode
}

/*
 * 用哪一家 agent 不从这里过。
 *
 * 能力表的接线落在组合根（见 shell/app-shell.tsx），于是这条链上没有一个渲染器
 * 需要认识 agentId 或那份配置。此前它们一路当 prop 往下递，四层里有三层只是原样
 * 转手，终点那一格拿去在 effect 里接一次线 —— 而那根线本来就不该从渲染树上走。
 */
export interface AssistantWiringOptions {
  /** 分叉出的对话开出来之后，去它那里 —— 与打开一条对话同一个动作。 */
  readonly onConversationForked: (threadId: string, title: string) => void
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
}

export function createAssistantWiring({
  onConversationForked,
  onConversationStarted,
  session,
}: AssistantWiringOptions): AssistantWiring {
  return {
    surfaces: {
      ai: () => <AssistantPane onConversationStarted={onConversationStarted} session={session} />,

      /*
       * 自动化那一格。渲染器现在是全域 Record（见 @poietica/workspace 的
       * surface.ts）：注册表里登记了 automations，这里就必须交出一条，
       * 漏掉是编译错误而不是一张空态图。
       */
      automations: () => <AutomationsView />,

      /* Tool 那一格。注册表里 tools 已经是 surface，漏掉这一条是编译错误。 */
      tools: () => <PluginsSurface store={pluginStore} />,
    },

    renderConversation: (threadId) => (
      <ConversationSurface
        onForked={onConversationForked}
        onStarted={onConversationStarted}
        session={session}
        threadId={threadId}
      />
    ),
  }
}
