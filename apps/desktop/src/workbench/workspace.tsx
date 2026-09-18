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
import {
  SidebarFooter,
  SurfaceHost,
  useWorkspaceLayoutState,
  WorkspaceShell,
  WorkspaceSidebar,
} from '../shell/index'
import { useWorkspaceLayoutStore } from '../shell/layout/layout-context'
import type { WorkspaceParts, WorkspaceShellActions } from '../shell/layout/shell-contract'
import { AuxiliaryDock } from './auxiliary-dock'
import type { WorkbenchHost } from './runtime-contract'
import { createDesktopSurfaces } from './surfaces'

export interface DesktopWorkspaceProps {
  readonly host: WorkbenchHost
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
  /** 资料库表面渲染器，由组合根注入（见 entry/compose-runtime.ts）。 */
  readonly librarySurface: () => ReactNode
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

/*
 * 设置页在右栏那一格的归属键。
 *
 * 与对话的 threadId 同一张表里的另一个键：threadId 是 uuid，撞不上。
 */
const SETTINGS_AUXILIARY_OWNER = 'settings'

interface AuxiliaryBinding {
  /** 这一格归谁：对话是它的 threadId，设置页是设置自己那个键。 */
  readonly owner: string | null
  /** 浏览器那一段算不算这一格的。 */
  readonly ownsBrowser: boolean
  readonly docked: boolean
}

/*
 * 右栏这一格的归属与在场。
 *
 * 设置页有自己那一格，与任何一条对话都不共用：在设置里点开的技能文档不会跑到对话的右栏里，
 * 对话那边的标签页也不会跟到设置里来；浏览器那一段更是宿主全局的一份，设置页不认领它。
 * 与布局里「哪条对话的右栏是开的」同一个道理 —— 状态按归属分账。
 *
 * 平时它跟着对话走：属于当前这条对话才停靠。设置打开时对话不在场，本来一律不出现 ——
 * 技能文档那一格是唯一的例外，它恰恰是被设置页点开的，所以它出现时右栏就出现。
 */
/*
 * 设置页右上角只有辅助开关，没有任务开关：那一格是技能文档（见 auxiliaryBinding）。
 * 它只在文档开着时出现，动作只有收起 —— 打开它的动作是点开一份技能文档，不是这枚按钮。
 */
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

  /* 「哪条对话在跑」只订一次：标签条与侧栏读同一份。 */
  const runningThreadIds = useRunningThreads()

  /* 标题栏的搜索按钮走命令注册表：注册表知道这条命令现在该做什么，这里不该再抄一遍。 */
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

  const auxiliaryState = useSyncExternalStore(
    auxiliaryPanel.subscribe,
    auxiliaryPanel.getSnapshot,
    auxiliaryPanel.getSnapshot,
  )

  const auxiliary = auxiliaryBinding({
    activeConversationId,
    auxiliaryThread,
    isSettingsOpen,
    panes: auxiliaryState.panes,
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

  const openConversationInNewTab = useCallback(
    (threadId: string, title: string) => {
      workspace.openConversationInNewTab({ threadId, title })
    },
    [workspace],
  )

  const desktopSurfaces = useMemo(
    () =>
      createDesktopSurfaces({
        pickWorkspace: host.pickWorkspace,
        automationStore,
        drafts: composerDrafts,
        personalization,
        library: librarySurface,
        /* 分叉出的对话就地打开：与点开列表里一条是同一个动作。 */
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
      if (activeConversationId === null) {
        return
      }

      auxiliaryPanel.openDelegate(activeConversationId, agentId)
      workspaceLayoutStore.setAuxiliaryThread(activeConversationId)
    },
    [activeConversationId, auxiliaryPanel, workspaceLayoutStore],
  )

  /* 技能文档落在设置那一格里：设置页只说要看的技能，开在哪一格是工作台的事。 */
  const openSkillDocument = useCallback(
    (skillId: string) => {
      auxiliaryPanel.openFile(SETTINGS_AUXILIARY_OWNER, skillId)
    },
    [auxiliaryPanel],
  )

  const parts: WorkspaceParts = {
    chrome: {
      /* 标题栏只剩开合、前后切换与窗口控制：标签条不再进这一行，见 workspace-shell.css
       * 里主区左上圆角那一段 —— 会话面板自己带圆角，与标签的 Chrome 形咬口互斥。 */
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
              onOpenInNewTab={openConversationInNewTab}
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
          host={host}
          isDocked={auxiliary.docked}
          owner={auxiliary.owner}
          ownsBrowser={auxiliary.ownsBrowser}
          skills={toolkit.skills}
          store={auxiliaryPanel}
        />
      ),
      isDocked: auxiliary.docked,
      /* 设置里这一列只有文档格，收起它就是把文档格关掉；对话那一路仍旧收起右栏。 */
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
