import type { AutomationStore } from '@poietica/automation'
import type { AgentSessionPort } from '@poietica/conversation'
import type { ComposerDrafts } from '@poietica/conversation/surface'
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
import type { AuxiliaryPanelStore } from '@poietica/workspace/panels'
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react'
import { AssistantSidebarPanel } from '../assistant/assistant-sidebar-panel'
import { ConversationControls, ConversationHeader } from '../assistant/conversation-header'
import {
  CONVERSATION_TODO_LAYOUT_STYLE,
  ConversationTodoPopover,
} from '../assistant/conversation-todo-popover'
import { useThreadsActions } from '../assistant/threads-context'
import { type ActiveTabSequence, DesktopTitleBar } from '../shell/chrome/title-bar'
import { tabNeighbors } from '../shell/commands/app-commands'
import {
  SidebarFooter,
  SurfaceHost,
  useWorkspaceLayoutState,
  WorkbenchTabs,
  WorkspaceShell,
  WorkspaceSidebar,
} from '../shell/index'
import { useWorkspaceLayoutStore } from '../shell/layout/layout-context'
import type { WorkspaceParts, WorkspaceShellActions } from '../shell/layout/shell-contract'
import { AuxiliaryDock } from './auxiliary-dock'
import { createDesktopSurfaces } from './surfaces'

export interface DesktopWorkspaceProps {
  readonly agentSession: AgentSessionPort
  readonly appVersion: () => Promise<string>
  /** 数据目录。与版本号同源同层：关于页面上的两个事实出自同一条链。 */
  readonly dataDirectory: () => Promise<string>
  /** Token 日账的读。与上面两个同源同层：用量页要的账只有原生侧那一份。 */
  readonly readTokenDays: SettingsProviderProps['readTokenDays']
  readonly workspace: WorkbenchSessionStore
  readonly commands: CommandRegistry
  readonly isSettingsOpen: boolean
  readonly onSettingsClose: () => void
  readonly settingsStore: SettingsStore
  readonly onThemeChange: SettingsProviderProps['onThemeChange']
  readonly agentSettings: AgentSettings
  /** 模型目录的唯一持有者，由组合根注入（见 entry/compose-runtime.ts）。 */
  readonly modelCatalog: ModelCatalogStore
  readonly composerDrafts: ComposerDrafts
  readonly personalization: PersonalizationStore
  readonly auxiliaryPanel: AuxiliaryPanelStore
  readonly plugins: PluginStore
  /** 进程级自动化表，由组合根构造注入（见 entry/compose-runtime.ts）。 */
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

/** 这一格是 AI 助手（真实对话或新建入口）时，页头与背景皮肤才挂出来。 */
function isAssistantChromeSurface(surface: WorkbenchSurfaceViewModel): boolean {
  return (
    surface.kind === 'conversation' || (surface.kind === 'surface' && surface.surfaceId === 'ai')
  )
}

export function DesktopWorkspace({
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

  /* 「哪条对话在跑」只订一次：标签条与侧栏读同一份。 */
  const runningThreadIds = useRunningThreads()

  const runCommand = useCallback(
    (commandId: string) => {
      void commands.execute(commandId)
    },
    [commands],
  )

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

      /* 只递 id：标题是注册表已经拥有的事实，递第二遍就是第二个来源。 */
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

  /* Toolkit scope belongs to the active workspace identity, not to whichever child mounted last. */

  const { auxiliaryThread, todoThread } = useWorkspaceLayoutState()
  const workspaceLayoutStore = useWorkspaceLayoutStore()

  const dockAuxiliary =
    !isSettingsOpen && auxiliaryThread !== null && auxiliaryThread === activeConversationId

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

  const openConversationInNewTab = useCallback(
    (threadId: string, title: string) => {
      workspace.openConversationInNewTab({ threadId, title })
    },
    [workspace],
  )

  const desktopSurfaces = useMemo(
    () =>
      createDesktopSurfaces({
        automationStore,
        drafts: composerDrafts,
        personalization,
        /* 分叉出的对话就地打开：与点开列表里一条是同一个动作。 */
        onConversationForked: startConversation,
        onConversationStarted: startConversation,
        pluginStore: plugins,
        session: agentSession,
      }),
    [agentSession, automationStore, composerDrafts, personalization, plugins, startConversation],
  )

  /* AI 入口晋升时只换 threadId；非 AI 表面仍由工作区的统一宿主渲染。 */
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

  /* 派发通道只有这一个入口：点开那一行，右侧那一格亮起来并停在这条通道上。 */
  const openDelegateChannel = useCallback(
    (agentId: string) => {
      auxiliaryPanel.openDelegate(agentId)

      if (activeConversationId !== null) {
        workspaceLayoutStore.setAuxiliaryThread(activeConversationId)
      }
    },
    [activeConversationId, auxiliaryPanel, workspaceLayoutStore],
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
        >
          {isSettingsOpen ? null : (
            <WorkbenchTabs
              onActivate={actions.activateTab}
              onClose={actions.closeTab}
              onCreate={openAssistantEntry}
              onMove={actions.moveTab}
              runningThreadIds={runningThreadIds}
              tabs={workbench.tabs}
            />
          )}
        </DesktopTitleBar>
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
          onCommand={runCommand}
          onCreateConversation={openAssistantEntry}
          onDeveloperToolsOpen={onDeveloperToolsOpen}
          onSettingsOpen={onSettingsOpen}
          onSurfaceActivate={actions.openSurface}
          panel={
            <AssistantSidebarPanel
              activeThreadId={activeConversationId}
              onCreate={openAssistantEntry}
              onOpen={startConversation}
              onOpenInNewTab={openConversationInNewTab}
              runningThreadIds={runningThreadIds}
            />
          }
          updateRow={updateRow}
        />
      ),
    },

    main: {
      controls:
        isSettingsOpen || activeConversationId === null ? null : (
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
        /* 任务面板按会话容器宽度在停靠与覆盖之间切换。 */
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

    /* 辅助面板是外壳的第三列，不是主区里的一块：开合走与侧栏同一条动画。 */
    auxiliary: {
      content: (
        <AuxiliaryDock
          conversationId={auxiliaryThread}
          isDocked={dockAuxiliary}
          store={auxiliaryPanel}
        />
      ),
      isDocked: dockAuxiliary,
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
      plugins={plugins}
      readTokenDays={readTokenDays}
      skills={toolkit.skills}
      store={settingsStore}
      threads={threads}
    >
      <DelegateChannelContext value={openDelegateChannel}>
        <WorkspaceShell model={workbench} parts={parts} />
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
