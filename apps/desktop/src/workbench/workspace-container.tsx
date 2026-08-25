import type { AgentSessionPort } from '@poietica/agent-contract'
import { DelegateChannelContext, useRunningThreads } from '@poietica/agent-ui'
import type { AgentConfigStore, KeybindingCatalog, SettingsStore } from '@poietica/settings'
import {
  SettingsContentRegion,
  SettingsNavigationRegion,
  SettingsProvider,
} from '@poietica/settings'
import type {
  CommandRegistry,
  WorkbenchSessionStore,
  WorkbenchTabId,
  WorkbenchTabViewModel,
  WorkspaceParts,
  WorkspaceShellActions,
} from '@poietica/workspace'
import {
  SidebarFooter,
  SurfaceHost,
  useWorkspaceLayoutState,
  WorkbenchTabs,
  WorkspaceShell,
  WorkspaceSidebar,
  workspaceLayoutStore,
} from '@poietica/workspace'
import { type ReactNode, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useThreadsActions } from '../assistant/threads-context'
import { BrowserDock } from '../browser/browser-dock'
import { browserPanelStore } from '../browser/browser-runtime'
import { type ActiveTabSequence, DesktopTitleBar } from '../chrome/desktop-title-bar'
import { AssistantSidebarPanel } from './assistant-sidebar-panel'
import { createAssistantWiring } from './assistant-wiring'
import { ConversationHeader } from './conversation-header'

/**
 * 运行期能力开关。
 *
 * 降级判断由 AppShell 从 failureCoordinator 派生一次，向下作为稳定引用传递；
 * UI 只把它映射成控件的 disabled，不在事件处理器里重复守卫——控件禁用之后
 * onClick 不会触发，那层守卫是死代码。
 */
export interface AppCapabilities {
  readonly settings: boolean
  readonly developerTools: boolean
  readonly windowControls: boolean
}

export interface WorkspaceContainerProps {
  readonly agentSession: AgentSessionPort
  readonly appVersion: () => Promise<string>
  /** 数据目录。与版本号同源同层：关于页面上的两个事实出自同一条链。 */
  readonly dataDirectory: () => Promise<string>
  readonly workspace: WorkbenchSessionStore
  readonly commands: CommandRegistry
  readonly capabilities: AppCapabilities
  readonly isSettingsOpen: boolean
  readonly onSettingsClose: () => void
  readonly settingsStore: SettingsStore
  readonly agentConfigStore: AgentConfigStore
  readonly keybindings: KeybindingCatalog
  readonly updateRow: ReactNode
  readonly isWindowMaximized: boolean
  readonly onDeveloperToolsOpen: () => void
  readonly onSettingsOpen: () => void
  readonly onWindowMinimize: () => void
  readonly onWindowMaximize: () => void
  readonly onWindowClose: () => void
}

/**
 * 工作区的组合根。
 *
 * 这一层的产物是一张 Part 表：chrome / sidebar / main 各是一格内容，
 * 外壳只负责把它们摆进栅格。此前这里向外壳递六个内容插槽外加一个渲染回调，
 * 外壳因此既要知道有哪些区域、又要把区域内部要用的数据回传给组合根 ——
 * 那是把布局职责和接线职责搅在一起。
 */
export function WorkspaceContainer({
  agentSession,
  appVersion,
  dataDirectory,
  workspace,
  commands,
  capabilities,
  isSettingsOpen,
  onSettingsClose,
  settingsStore,
  agentConfigStore,
  keybindings,
  updateRow,
  isWindowMaximized,
  onDeveloperToolsOpen,
  onSettingsOpen,
  onWindowMinimize,
  onWindowMaximize,
  onWindowClose,
}: WorkspaceContainerProps) {
  const workbench = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
    workspace.getSnapshot,
  )

  const threads = useThreadsActions()

  /* 「哪条对话在跑」只订一次：标签条与侧栏读同一份。 */
  const runningThreadIds = useRunningThreads()

  /*
   * 一条对话被删除时，开着它的那一格跟着消失。
   *
   * 接线只有这一处：删除的写路径是 ThreadsStore.remove，工作台在这里听它。
   * 侧栏那个菜单项因此不需要知道标签的存在 —— 否则命令面板、快捷键、以后
   * 任何第二个删除入口都要各自记得再关一次标签，漏一个就是一个 bug。
   */
  useEffect(() => threads.onRemoved(workspace.closeConversation), [threads, workspace])

  /*
   * 导航里的动作行走命令注册表，不另接一根专线。
   *
   * 「搜索」那一行、Mod+K、以及面板里那一条，是同一个 id 的同一次执行 ——
   * 三个入口一份行为，以后改行为只改一处。
   */
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
  const { browserThread } = useWorkspaceLayoutState()

  /*
   * 浏览器在不在场，一处判定：它归 browserThread 那条对话，而那条对话此刻得真的
   * 在屏幕上。停靠位与原生 webview 的可见性都读这一个布尔。
   */
  const dockBrowser =
    !isSettingsOpen && browserThread !== null && browserThread === activeConversationId

  /*
   * 高亮只有一处：看着一条对话时，亮的是列表里那一行，导航不陪着亮 ——
   * 此前这里恒为 'ai'，于是导航行与对话行两个「当前位置」同时亮。「新建
   * 对话」只在入口表面真的在屏幕上时才亮；标签条上的图标规则不受影响
   * （见 WorkbenchTab.resolveTabIcon），那是另一格的事。
   */
  const activeNavigationId =
    workbench.activeSurface.kind === 'surface' ? workbench.activeSurface.surfaceId : null

  /*
   * 一条对话开口说话的那一刻，AI 那一格就变成这条对话。
   *
   * openConversation 会就地顶掉 surface:ai（会话槽本来的规则），于是标签
   * 标题变成这句话、activeSurface 变成 conversation，左侧高亮也随之落到列表
   * 的那一行——三件事同一个来源，不需要各自同步。
   */
  const startConversation = useCallback(
    (threadId: string, title: string) => {
      workspace.openConversation({ threadId, title })
    },
    [workspace],
  )

  /*
   * 侧栏那几根线也钉住标识：它们此前是 JSX 里的内联箭头，于是任何一次无关
   * 重渲都要把整张会话列表重画一遍。
   *
   * 打开一条对话与「说出第一句话」是同一件事，共用 startConversation。
   */
  const openAssistantEntry = useCallback(() => {
    workspace.openSurface({ surfaceId: 'ai' })
  }, [workspace])

  const openConversationInNewTab = useCallback(
    (threadId: string, title: string) => {
      workspace.openConversationInNewTab({ threadId, title })
    },
    [workspace],
  )

  const assistant = useMemo(
    () =>
      createAssistantWiring({
        /* 分叉出的对话就地打开：与点开列表里一条是同一个动作。 */
        onConversationForked: startConversation,
        onConversationStarted: startConversation,
        session: agentSession,
      }),
    [agentSession, startConversation],
  )

  /* 两种表面形态，穷尽，没有兜底分支：一条对话，或者一个工作区表面。 */
  const surface =
    workbench.activeSurface.kind === 'conversation' ? (
      assistant.renderConversation(workbench.activeSurface.threadId)
    ) : (
      <SurfaceHost renderers={assistant.surfaces} surfaceId={workbench.activeSurface.surfaceId} />
    )

  /*
   * 设置界面没有标签：标签属于工作台，不属于设置。它接管的是主区与侧栏两格，
   * 其余部分照旧 —— 工作区留在下面不卸载，返回要回到进入设置前的那个标签页。
   */
  /* 派发通道只有这一个入口：点开那一行，右侧那一格亮起来并停在这条通道上。 */
  const openDelegateChannel = useCallback(
    (toolCallId: string) => {
      browserPanelStore.openPane(toolCallId)

      if (activeConversationId !== null) {
        workspaceLayoutStore.setBrowserThread(activeConversationId)
      }
    },
    [activeConversationId],
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
          windowControlsDisabled={!capabilities.windowControls}
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
      content: isSettingsOpen ? (
        <SettingsContentRegion />
      ) : (
        /*
         * 左列是对话（页头 + 画布），右侧是满高的浏览器 dock。dock 的标签
         * 条与页头同行高，开关在两者右角间交接座位，屏幕坐标不变。页头与
         * 雾只在对话里出现；浏览器开合状态活在 browserPanelStore，一份，
         * 跨表面与设置往返不丢。
         */
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {workbench.activeSurface.kind === 'conversation' ? (
            <ConversationHeader conversationId={workbench.activeSurface.threadId} />
          ) : null}
          <div className="relative min-h-0 min-w-0 flex-1">
            {workbench.activeSurface.kind === 'conversation' ? (
              <div className="conversation-veil" data-assistant-skin />
            ) : null}
            {surface}
          </div>
        </div>
      ),
      label: isSettingsOpen ? '设置' : undefined,
    },

    /* 浏览器是外壳的第三列，不是主区里的一块：开合走与侧栏同一条动画。 */
    browser: {
      content: <BrowserDock conversationId={activeConversationId} isDocked={dockBrowser} />,
      isDocked: dockBrowser,
    },
  }

  /*
   * 树形不随设置开合改变：返回值的根元素类型一变，React 就重置整棵子树，
   * 那是一次全窗重画。设置态只换 parts 里 sidebar 与 main 两格的内容。
   */
  return (
    <SettingsProvider
      agentConfigStore={agentConfigStore}
      appVersion={appVersion}
      dataDirectory={dataDirectory}
      isOpen={isSettingsOpen}
      keybindings={keybindings}
      onDismiss={onSettingsClose}
      store={settingsStore}
      threads={threads}
    >
      <DelegateChannelContext value={openDelegateChannel}>
        <WorkspaceShell model={workbench} parts={parts} />
      </DelegateChannelContext>
    </SettingsProvider>
  )
}

/*
 * 两个箭头指向活动标签的前后邻居：索引只在这里算一次，切换仍旧走 store 的
 * activateTab（点击标签、命令面板用的是同一个入口）。
 *
 * 可用性不是另算的布尔，而是邻居存不存在——一次查找同时给出「能不能按」和
 * 「按了去哪」，两者不可能不一致。两端因此天然不回绕。
 */
function describeTabSequence(
  tabs: readonly WorkbenchTabViewModel[],
  onActivateTab: (tabId: WorkbenchTabId) => void,
): ActiveTabSequence {
  const index = tabs.findIndex((tab) => tab.isActive)
  const previous = index > 0 ? tabs[index - 1] : undefined
  const next = index >= 0 && index < tabs.length - 1 ? tabs[index + 1] : undefined

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
