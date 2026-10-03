import { type ConversationRuntime, groupByWorkspace } from '@poietica/conversation'
import { watchBrowserDriven } from '@poietica/native-bridge/browser'
import type { CommandRegistry, RegisteredCommand, WorkbenchSessionStore } from '@poietica/workspace'
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
    /*
     * 一整批一起登记：逐条 register 会让每个订阅者被叫 2N 次，而订阅者里有键位表的
     * 重建（app-shell.tsx 的 createKeybindingCatalog、keybinding.ts 的 chordIndex）。
     * 一次列表变化要换掉所有「打开某条会话」，中间态不是任何人要看的快照。
     */
    const next: RegisteredCommand[] = []
    for (const group of groupByWorkspace(items)) {
      for (const item of group.items) {
        next.push({
          id: 'conversation.open:'.concat(item.id),
          label: item.title,
          category: '聊天',
          ...(group.name === null ? {} : { detail: group.name }),
          execute: () => {
            workspace.openConversation({ threadId: item.id, title: item.title })
          },
        })
      }
    }
    commandReleases.push(commands.registerAll(next))
  }
  /*
   * agent 要用浏览器了：把右栏开出来并停在浏览器那一段。
   *
   * 这是「用户看得见 AI 在动哪个页面」的那一步 —— 面板关着或停在别的通道上时，宿主
   * 那边的视图是藏起来的（auxiliary-dock 的 setVisible 只认「停靠且焦点在浏览器」），
   * 不自己开出来用户就什么都看不到。
   *
   * 走 claimAuxiliaryThread 而不是 setAuxiliaryThread：用户自己把右栏让给别的对话时
   * （那是一条明确的选择）不许被抢走；而在当前对话上没开右栏时它才开。
   */
  const browserDriven = (): void => {
    if (stopped) {
      return
    }
    const surface = workspace.getSnapshot().activeSurface
    if (surface.kind !== 'conversation' || !layout.claimAuxiliaryThread(surface.threadId)) {
      return
    }
    auxiliaryPanel.selectBrowser()
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
    releases.push(watchBrowserDriven(browserDriven))
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
