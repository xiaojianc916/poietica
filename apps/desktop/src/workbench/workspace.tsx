import type { AutomationStore } from '@poietica/automation'
import type { AgentSessionPort, ComposerDrafts } from '@poietica/conversation'
import {
  DelegateChannelContext,
  useAgentControls,
  useRunningThreads,
} from '@poietica/conversation/surface'
import type { PluginStore } from '@poietica/extension'
import type {
  AgentSettings,
  KeybindingCatalog,
  ModelCatalogStore,
  PersonalizationStore,
  SettingsStore,
} from '@poietica/settings'
import {
  SettingsContentRegion,
  SettingsNavigationRegion,
  SettingsProvider,
  type SettingsProviderProps,
} from '@poietica/settings/ui'
import type {
  CommandRegistry,
  WorkbenchSessionStore,
  WorkbenchSurfaceViewModel,
  WorkbenchTabId,
  WorkbenchTabViewModel,
} from '@poietica/workspace'
import type { AuxiliaryPane, AuxiliaryPanelStore } from '@poietica/workspace/panels'
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react'
import { AssistantSidebarPanel } from '../assistant/assistant-sidebar-panel'
import {
  AuxiliaryToggle,
  ConversationControls,
  ConversationHeader,
} from '../assistant/conversation-header'
import {
  CONVERSATION_TODO_LAYOUT_STYLE,
  ConversationTodoPopover,
} from '../assistant/conversation-todo-popover'
import { useThreadsActions } from '../assistant/threads-context'
import { type ActiveTabSequence, DesktopTitleBar } from '../shell/chrome/title-bar'
import { TOGGLE_COMMAND_PALETTE_COMMAND_ID, tabNeighbors } from '../shell/commands/app-commands'
import { SidebarFooter, SurfaceHost, WorkspaceShell, WorkspaceSidebar } from '../shell/index'
import { useWorkspaceLayoutStore, useWorkspaceLayoutValue } from '../shell/layout/layout-context'
import type { WorkspaceParts, WorkspaceShellActions } from '../shell/layout/shell-contract'
import { AuxiliaryDock } from './auxiliary-dock'
import type { WorkbenchHost } from './runtime-contract'
import { createDesktopSurfaces } from './surfaces'

export interface DesktopWorkspaceProps {
  readonly host: WorkbenchHost
  readonly agentSession: AgentSessionPort
  readonly appVersion: () => Promise<string>
  readonly dataDirectory: () => Promise<string>
  readonly readTokenDays: SettingsProviderProps['readTokenDays']
  readonly workspace: WorkbenchSessionStore
  readonly commands: CommandRegistry
  readonly isSettingsOpen: boolean
  readonly onSettingsClose: () => void
  readonly settingsStore: SettingsStore
  readonly onThemeChange: SettingsProviderProps['onThemeChange']
  readonly agentSettings: AgentSettings
  readonly modelCatalog: ModelCatalogStore
  readonly composerDrafts: ComposerDrafts
  readonly personalization: PersonalizationStore
  readonly librarySurface: () => ReactNode
  readonly auxiliaryPanel: AuxiliaryPanelStore
  readonly plugins: PluginStore
  readonly automationStore: AutomationStore
  readonly keybindings: KeybindingCatalog
  readonly updateRow: ReactNode
  readonly isWindowMaximized: boolean
  readonly onDeveloperToolsOpen: () => void
  readonly onSettingsOpen: () => void
  readonly onWindowMinimize: () => void
  readonly onWindowMaximize: () => void
  readonly onWindowClose: () => void
}

function isAssistantChromeSurface(surface: WorkbenchSurfaceViewModel): boolean {
  return (
    surface.kind === 'conversation' || (surface.kind === 'surface' && surface.surfaceId === 'ai')
  )
}

// 归属键与对话的 threadId 同一张表：threadId 是 uuid，撞不上这个字面量。
const SETTINGS_AUXILIARY_OWNER = 'settings'

interface AuxiliaryBinding {
  readonly owner: string | null
  readonly ownsBrowser: boolean
  readonly docked: boolean
}

function SettingsAuxiliaryControl({
  docked,
  onClose,
}: {
  readonly docked: boolean
  readonly onClose: () => void
}): ReactNode {
  return docked ? <AuxiliaryToggle auxiliaryOpen onToggleAuxiliary={onClose} /> : null
}

function auxiliaryBinding(input: {
  readonly activeConversationId: string | null
  readonly auxiliaryThread: string | null
  readonly isSettingsOpen: boolean
  readonly panes: readonly AuxiliaryPane[]
}): AuxiliaryBinding {
  if (input.isSettingsOpen) {
    return {
      docked: input.panes.some((pane) => pane.kind === 'file'),
      owner: SETTINGS_AUXILIARY_OWNER,
      ownsBrowser: false,
    }
  }

  return {
    docked: input.auxiliaryThread !== null && input.auxiliaryThread === input.activeConversationId,
    owner: input.auxiliaryThread,
    ownsBrowser: true,
  }
}

export function DesktopWorkspace({
  host,
  agentSession,
  appVersion,
  dataDirectory,
  readTokenDays,
  workspace,
  commands,
  isSettingsOpen,
  onSettingsClose,
  settingsStore,
  onThemeChange,
  agentSettings,
  modelCatalog,
  composerDrafts,
  personalization,
  librarySurface,
  auxiliaryPanel,
  plugins,
  automationStore,
  keybindings,
  updateRow,
  isWindowMaximized,
  onDeveloperToolsOpen,
  onSettingsOpen,
  onWindowMinimize,
  onWindowMaximize,
  onWindowClose,
}: DesktopWorkspaceProps) {
  const workbench = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
    workspace.getSnapshot,
  )

  const threads = useThreadsActions()
  const { toolkit } = useAgentControls()

  const runningThreadIds = useRunningThreads()

  const openSearch = useCallback(() => {
    void commands.execute(TOGGLE_COMMAND_PALETTE_COMMAND_ID)
  }, [commands])

  const actions = useMemo<WorkspaceShellActions>(
    () => ({
      activateTab(tabId) {
        workspace.activateTab(tabId)
      },

      closeTab(tabId) {
        workspace.closeTab(tabId)
      },

      moveTab(tabId, targetIndex) {
        workspace.moveTab(tabId, targetIndex)
      },

      openSurface(surfaceId) {
        workspace.openSurface({ surfaceId })
      },

      openDeveloperTools: onDeveloperToolsOpen,

      openSettingsWindow: onSettingsOpen,
    }),
    [onDeveloperToolsOpen, onSettingsOpen, workspace],
  )

  /* 侧栏高亮的那一行就是正在看的那一格：身份来自工作台，没有第二份状态。 */
  const activeConversationId =
    workbench.activeSurface.kind === 'conversation' ? workbench.activeSurface.threadId : null

  const showAssistantChrome = isAssistantChromeSurface(workbench.activeSurface)

  // 只订所需字段：拖宽是 pointermove 频率的通报，全量订阅会把整棵工作台树拖进每一帧的重渲染。
  const auxiliaryThread = useWorkspaceLayoutValue((state) => state.auxiliaryThread)
  const todoThread = useWorkspaceLayoutValue((state) => state.todoThread)
  const auxiliaryPanes = useSyncExternalStore(
    auxiliaryPanel.subscribe,
    () => auxiliaryPanel.getSnapshot().panes,
    () => auxiliaryPanel.getSnapshot().panes,
  )
  const workspaceLayoutStore = useWorkspaceLayoutStore()

  const auxiliary = auxiliaryBinding({
    activeConversationId,
    auxiliaryThread,
    isSettingsOpen,
    panes: auxiliaryPanes,
  })

  const activeNavigationId =
    workbench.activeSurface.kind === 'surface' ? workbench.activeSurface.surfaceId : null

  const startConversation = useCallback(
    (threadId: string, title: string) => {
      workspace.openConversation({ threadId, title })
    },
    [workspace],
  )

  const openAssistantEntry = useCallback(() => {
    workspace.openSurface({ surfaceId: 'ai' })
  }, [workspace])

  const desktopSurfaces = useMemo(
    () =>
      createDesktopSurfaces({
        pickWorkspace: host.pickWorkspace,
        automationStore,
        drafts: composerDrafts,
        personalization,
        library: librarySurface,
        onConversationForked: startConversation,
        onConversationStarted: startConversation,
        session: agentSession,
      }),
    [
      agentSession,
      automationStore,
      composerDrafts,
      host.pickWorkspace,
      librarySurface,
      personalization,
      startConversation,
    ],
  )

  const surface =
    workbench.activeSurface.kind === 'conversation' ? (
      desktopSurfaces.renderAssistant(workbench.activeSurface.threadId)
    ) : workbench.activeSurface.surfaceId === 'ai' ? (
      desktopSurfaces.renderAssistant()
    ) : (
      <SurfaceHost
        renderers={desktopSurfaces.surfaces}
        surfaceId={workbench.activeSurface.surfaceId}
      />
    )

  const openDelegateChannel = useCallback(
    (agentId: string) => {
      if (activeConversationId === null) {
        return
      }

      auxiliaryPanel.openDelegate(activeConversationId, agentId)
      workspaceLayoutStore.setAuxiliaryThread(activeConversationId)
    },
    [activeConversationId, auxiliaryPanel, workspaceLayoutStore],
  )

  const openSkillDocument = useCallback(
    (skillId: string) => {
      auxiliaryPanel.openFile(SETTINGS_AUXILIARY_OWNER, skillId)
    },
    [auxiliaryPanel],
  )

  const parts: WorkspaceParts = {
    chrome: {
      content: (
        <DesktopTitleBar
          activeTabSequence={describeTabSequence(
            isSettingsOpen ? [] : workbench.tabs,
            actions.activateTab,
          )}
          isMaximized={isWindowMaximized}
          onClose={onWindowClose}
          onMaximize={onWindowMaximize}
          onMinimize={onWindowMinimize}
          onOpenSearch={openSearch}
        />
      ),
    },

    sidebar: {
      content: isSettingsOpen ? (
        <SettingsNavigationRegion
          footer={
            <SidebarFooter
              onDeveloperToolsOpen={onDeveloperToolsOpen}
              onSettingsOpen={onSettingsClose}
              settingsActive
              updateRow={updateRow}
            />
          }
        />
      ) : (
        <WorkspaceSidebar
          activeNavigationId={activeNavigationId}
          onCreateConversation={openAssistantEntry}
          onDeveloperToolsOpen={onDeveloperToolsOpen}
          onSettingsOpen={onSettingsOpen}
          onSurfaceActivate={actions.openSurface}
          panel={
            <AssistantSidebarPanel
              activeThreadId={activeConversationId}
              onCreate={openAssistantEntry}
              onOpen={startConversation}
              runningThreadIds={runningThreadIds}
            />
          }
          updateRow={updateRow}
        />
      ),
    },

    main: {
      controls: isSettingsOpen ? (
        <SettingsAuxiliaryControl
          docked={auxiliary.docked}
          onClose={auxiliaryPanel.closeFilePanes}
        />
      ) : activeConversationId === null ? null : (
        <ConversationControls
          auxiliaryOpen={auxiliaryThread === activeConversationId}
          onToggleAuxiliary={() =>
            workspaceLayoutStore.setAuxiliaryThread(
              auxiliaryThread === activeConversationId ? null : activeConversationId,
            )
          }
          onToggleTodo={() =>
            workspaceLayoutStore.setTodoThread(
              todoThread === activeConversationId ? null : activeConversationId,
            )
          }
          todoOpen={todoThread === activeConversationId}
        />
      ),
      content: isSettingsOpen ? (
        <SettingsContentRegion />
      ) : (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {showAssistantChrome ? <ConversationHeader /> : null}
          <div className="conversation-body" style={CONVERSATION_TODO_LAYOUT_STYLE}>
            <div className="conversation-canvas">
              {showAssistantChrome ? (
                <div className="conversation-veil" data-assistant-skin />
              ) : null}
              {surface}
              {workbench.activeSurface.kind === 'conversation' ? (
                <ConversationTodoPopover
                  open={todoThread === workbench.activeSurface.threadId}
                  threadId={workbench.activeSurface.threadId}
                />
              ) : null}
            </div>
          </div>
        </div>
      ),
      label: isSettingsOpen ? '设置' : undefined,
    },

    auxiliary: {
      content: (
        <AuxiliaryDock
          conversationId={auxiliaryThread}
          host={host}
          isDocked={auxiliary.docked}
          owner={auxiliary.owner}
          ownsBrowser={auxiliary.ownsBrowser}
          skills={toolkit.skills}
          store={auxiliaryPanel}
        />
      ),
      isDocked: auxiliary.docked,
      onClose: isSettingsOpen ? auxiliaryPanel.closeFilePanes : undefined,
    },
  }

  return (
    <SettingsProvider
      agentSettings={agentSettings}
      appVersion={appVersion}
      dataDirectory={dataDirectory}
      isOpen={isSettingsOpen}
      keybindings={keybindings}
      modelCatalog={modelCatalog}
      onDismiss={onSettingsClose}
      onThemeChange={onThemeChange}
      openSkillDocument={openSkillDocument}
      plugins={plugins}
      readTokenDays={readTokenDays}
      skills={toolkit.skills}
      store={settingsStore}
      threads={threads}
    >
      <DelegateChannelContext value={openDelegateChannel}>
        <WorkspaceShell parts={parts} />
      </DelegateChannelContext>
    </SettingsProvider>
  )
}

function describeTabSequence(
  tabs: readonly WorkbenchTabViewModel[],
  onActivateTab: (tabId: WorkbenchTabId) => void,
): ActiveTabSequence {
  const { next, previous } = tabNeighbors(tabs, tabs.find((tab) => tab.isActive)?.id)

  return {
    canActivatePrevious: previous !== undefined,
    canActivateNext: next !== undefined,
    activatePrevious() {
      if (previous) {
        onActivateTab(previous.id)
      }
    },
    activateNext() {
      if (next) {
        onActivateTab(next.id)
      }
    },
  }
}
