import { type ConversationRuntime, groupByWorkspace } from '@poietica/conversation'
import type { CommandRegistry, WorkbenchSessionStore } from '@poietica/workspace'
import type { AuxiliaryPanelStore } from '@poietica/workspace/panels'
import type { ConversationEntry } from '../assistant/conversation-entry'
import type { WorkspaceLayoutStore } from '../shell/layout/layout-store'

interface Connections {
  readonly workspace: WorkbenchSessionStore
  readonly conversation: ConversationRuntime
  readonly commands: CommandRegistry
  readonly auxiliaryPanel: AuxiliaryPanelStore
  readonly layout: WorkspaceLayoutStore
  readonly conversationEntry: ConversationEntry
}
export function connectWorkbench(input: Connections): () => void {
  const { workspace, conversation, commands, auxiliaryPanel, layout, conversationEntry } = input
  const threads = conversation.threads
  const releases: Array<() => void> = []
  const commandReleases: Array<() => void> = []
  let stopped = false
  let listed: ReturnType<typeof threads.listSnapshot>['items'] | undefined
  let browserLoading = false
  const initial = workspace.getSnapshot().activeSurface
  let atEntry = initial.kind === 'surface' && initial.surfaceId === 'ai'

  const release = (): void => {
    stopped = true
    const failures: unknown[] = []
    for (const stop of [...releases.splice(0).reverse(), ...commandReleases.splice(0).reverse()]) {
      try {
        stop()
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Workbench connections did not all stop.')
    }
  }
  const activeChanged = (): void => {
    if (stopped) {
      return
    }
    const surface = workspace.getSnapshot().activeSurface
    const entry = surface.kind === 'surface' && surface.surfaceId === 'ai'
    if (entry && !atEntry) {
      conversationEntry.begin()
    }
    atEntry = entry
    conversation.capabilities.adoptToolkit(
      surface.kind === 'conversation' ? surface.threadId : null,
    )
  }
  const listChanged = (): void => {
    if (stopped) {
      return
    }
    const items = threads.listSnapshot().items
    if (listed === items) {
      return
    }
    listed = items
    for (const stop of commandReleases.splice(0).reverse()) {
      stop()
    }
    for (const group of groupByWorkspace(items)) {
      for (const item of group.items) {
        commandReleases.push(
          commands.register({
            id: 'conversation.open:'.concat(item.id),
            label: item.title,
            category: '聊天',
            ...(group.name === null ? {} : { detail: group.name }),
            execute: () => {
              workspace.openConversation({ threadId: item.id, title: item.title })
            },
          }),
        )
      }
    }
  }
  const browserChanged = (): void => {
    if (stopped) {
      return
    }
    const loading =
      auxiliaryPanel.getSnapshot().host?.tabs.some((tab) => tab.loading && tab.url !== null) ??
      false
    const rising = loading && !browserLoading
    browserLoading = loading
    const surface = workspace.getSnapshot().activeSurface
    if (
      rising &&
      surface.kind === 'conversation' &&
      layout.claimAuxiliaryThread(surface.threadId)
    ) {
      auxiliaryPanel.selectBrowser()
    }
  }
  try {
    releases.push(workspace.subscribe(activeChanged))
    releases.push(threads.subscribe(listChanged))
    releases.push(
      threads.onRemoved((threadId) => {
        workspace.closeConversation(threadId)
        layout.forgetThread(threadId)
      }),
    )
    releases.push(auxiliaryPanel.subscribe(browserChanged))
    activeChanged()
    listChanged()
    browserChanged()
  } catch (cause) {
    try {
      release()
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Workbench connection setup and cleanup failed.')
    }
    throw cause
  }
  return release
}
