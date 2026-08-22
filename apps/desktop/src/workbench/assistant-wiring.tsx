import type { AgentSessionPort } from '@poietica/agent-contract'
import type { ComposerSkill } from '@poietica/agent-ui'
import { PluginsSurface, type PluginStore } from '@poietica/plugins'
import type { SurfaceRenderers } from '@poietica/workspace'
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react'
import { AutomationsView } from '../automations/automations-view'
import { pluginStore } from '../plugins/plugin-runtime'
import { AssistantPane } from './assistant-pane'
import { ConversationSurface } from './conversation-surface'

/**
 * AI 接入工作区的全部接线。
 *
 * packages/workspace 只认识插槽和 surface 种类,agent 那边只认识会话端口,
 * 两者互不认识;会话端口在这里、且只在这里交出去。
 */
export interface AssistantWiring {
  readonly surfaces: SurfaceRenderers
  readonly renderConversation: (threadId: string) => ReactNode
}

export interface AssistantWiringOptions {
  readonly onConversationForked: (threadId: string, title: string) => void
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
}

function useInstalledSkills(store: PluginStore): readonly ComposerSkill[] {
  const read = useCallback(() => store.getSnapshot().skills, [store])
  const installed = useSyncExternalStore(store.subscribe, read, read)

  return useMemo(
    () =>
      installed.map((skill) => ({
        name: skill.dirName,
        ...(skill.manifest.name === skill.dirName ? {} : { label: skill.manifest.name }),
        description: skill.manifest.description ?? '',
      })),
    [installed],
  )
}

function AssistantEntry({
  onConversationStarted,
  session,
  store,
}: {
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  readonly store: PluginStore
}) {
  const skills = useInstalledSkills(store)

  return (
    <AssistantPane
      entrySkills={skills}
      onConversationStarted={onConversationStarted}
      session={session}
    />
  )
}

function AssistantConversation({
  onConversationForked,
  onConversationStarted,
  session,
  store,
  threadId,
}: {
  readonly onConversationForked: (threadId: string, title: string) => void
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  readonly store: PluginStore
  readonly threadId: string
}) {
  const skills = useInstalledSkills(store)

  return (
    <ConversationSurface
      entrySkills={skills}
      onForked={onConversationForked}
      onStarted={onConversationStarted}
      session={session}
      threadId={threadId}
    />
  )
}

export function createAssistantWiring({
  onConversationForked,
  onConversationStarted,
  session,
}: AssistantWiringOptions): AssistantWiring {
  return {
    surfaces: {
      ai: () => (
        <AssistantEntry
          onConversationStarted={onConversationStarted}
          session={session}
          store={pluginStore}
        />
      ),
      automations: () => <AutomationsView />,
      tools: () => <PluginsSurface store={pluginStore} />,
    },

    renderConversation: (threadId) => (
      <AssistantConversation
        onConversationForked={onConversationForked}
        onConversationStarted={onConversationStarted}
        session={session}
        store={pluginStore}
        threadId={threadId}
      />
    ),
  }
}
