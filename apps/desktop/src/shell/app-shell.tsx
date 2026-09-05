import { AgentControlsContext, AttachmentIntakeContext } from '@poietica/assistant'
import type { MainWindowController } from '@poietica/native-bridge'
import { failureCoordinator } from '@poietica/problem'
import type { KeybindingCatalog, KeybindingEntry } from '@poietica/settings'
import type { CommandRegistry } from '@poietica/workspace'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ConversationCommands } from '../assistant/conversation-commands'
import { ThreadsProvider } from '../assistant/threads-provider'
import type { ApplicationRuntime } from '../entry/compose-runtime'
import { NoticeRegion } from '../notice/notice-region'
import { reportFailure } from '../notice/problem-presentation'
import { UpdateCapsule } from '../update/update-capsule'
import { UpdateRow } from '../update/update-row'
import { useWindowChrome } from '../window/use-window-chrome'
import { CommandPalette, formatKeybinding, useCommandKeybindings } from './commands'
import {
  type ApplicationCommandContext,
  registerApplicationCommands,
} from './commands/app-commands'
import { WorkspaceContainer } from './workspace-container'
import { workspaceLayoutStore } from './workspace-layout-store'

interface AppShellProps {
  readonly runtime: ApplicationRuntime
}

export function AppShell({ runtime }: AppShellProps) {
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false)

  const [isSettingsOpen, setSettingsOpen] = useState(false)

  const {
    isMaximized: isWindowMaximized,
    minimize: minimizeWindow,
    toggleMaximize: maximizeWindow,
    quit: closeWindow,
  } = useWindowChrome(runtime.mainWindow, runtime.dispose)

  const failureSnapshot = useSyncExternalStore(
    failureCoordinator.subscribe,
    failureCoordinator.getSnapshot,
    failureCoordinator.getSnapshot,
  )

  /* FailureCoordinator.publish() 每次都换新 Map：降级判定取布尔，不取 Map 引用。 */
  const degraded = failureSnapshot.degradedFeatures

  const canOpenSettings = !degraded.has('settings')
  const canOpenDeveloperTools = !degraded.has('developer-tools')

  const updates = runtime.updates
  const agentControls = runtime.conversation.capabilities

  const toggleCommandPalette = useCallback(() => {
    setCommandPaletteOpen((open) => !open)
  }, [])

  const openAssistantSurface = useCallback(() => {
    runtime.workspace.openSurface({ surfaceId: 'ai' })
  }, [runtime.workspace])

  const openSettings = useCallback(() => {
    if (canOpenSettings) {
      setSettingsOpen(true)
    }
  }, [canOpenSettings])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
  }, [])

  const openDeveloperTools = useCallback(() => {
    if (!canOpenDeveloperTools) {
      return
    }

    void runtime.mainWindow.openDeveloperTools().catch((cause: unknown) => {
      reportFailure('DEVELOPER_TOOLS_UNAVAILABLE', {
        scope: 'app-shell',
        operation: 'open-developer-tools',
        cause,
      })
    })
  }, [canOpenDeveloperTools, runtime.mainWindow])

  const commandContext = useMemo<ApplicationCommandContext>(
    () => ({
      workspace: runtime.workspace,
      toggleCommandPalette,
      openAssistantSurface,
      openSettings,
      toggleSidebar: workspaceLayoutStore.toggleSidebar,
    }),
    [openAssistantSurface, openSettings, runtime.workspace, toggleCommandPalette],
  )

  /* 依赖是具体引用，不是整个 runtime：否则任一无关字段变化都会全量重注册。 */
  useEffect(
    () => registerApplicationCommands(runtime.commands, commandContext),
    [commandContext, runtime.commands],
  )

  const [keybindings] = useState(() => createKeybindingCatalog(runtime.commands))

  useCommandKeybindings(runtime.commands)

  useTerminationRequests(runtime.mainWindow, closeWindow)

  return (
    /*
     * 会话状态在这里落地，一个进程一份。
     *
     * 它比工作区更宽：侧栏的列表、标签条上的那一格、输入框旁的选择器读的是
     * 同一份，否则列表亮着一条而标签停在另一条。
     */
    <AttachmentIntakeContext value={runtime.attachments}>
      <AgentControlsContext value={agentControls}>
        <ThreadsProvider conversation={runtime.conversation}>
          {/*
          同样无渲染产出：把会话列表贡献进命令注册表，于是搜索框里第一组就是
          「聊天」。必须在 ThreadsProvider 之内 —— 它读的就是那份列表。
        */}
          <ConversationCommands registry={runtime.commands} workspace={runtime.workspace} />

          <WorkspaceContainer
            agentSession={runtime.agent.session}
            agentSettings={runtime.agentConfig}
            appVersion={runtime.appVersion}
            automationStore={runtime.automationStore}
            commands={runtime.commands}
            customAgentStore={runtime.customAgents}
            dataDirectory={runtime.dataDirectory}
            isSettingsOpen={isSettingsOpen && canOpenSettings}
            isWindowMaximized={isWindowMaximized}
            keybindings={keybindings}
            modelCatalog={runtime.modelCatalog}
            onDeveloperToolsOpen={openDeveloperTools}
            onSettingsClose={closeSettings}
            onSettingsOpen={openSettings}
            onThemeChange={runtime.theme.setPreference}
            onWindowClose={closeWindow}
            onWindowMaximize={maximizeWindow}
            onWindowMinimize={minimizeWindow}
            plugins={runtime.pluginStore}
            readTokenDays={runtime.readTokenDays}
            settingsStore={runtime.settings}
            updateRow={<UpdateRow store={updates} />}
            workspace={runtime.workspace}
          />

          <CommandPalette
            onOpenChange={setCommandPaletteOpen}
            open={isCommandPaletteOpen}
            registry={runtime.commands}
          />

          <UpdateCapsule store={updates} />

          <NoticeRegion />
        </ThreadsProvider>
      </AgentControlsContext>
    </AttachmentIntakeContext>
  )
}

/*
 * 关闭按钮与托盘"退出程序"是同一件事的两个入口，因此汇入同一个回调。
 * 托盘此前直接 app.exit(0)，绕开了窗口自己的关闭路径。
 */
function useTerminationRequests(
  mainWindow: MainWindowController,
  onCloseRequested: () => void,
): void {
  useEffect(() => {
    /*
     * 两个入口只在「订阅哪一个」上不同，所以它们是一张表里的两行，不是两段手抄。
     * 上一版为此写了一个 track 辅助函数，它的第二个参数唯一的用途是被 void 掉。
     */
    const channels = [
      {
        operation: 'register-close-listener',
        subscribe: () => mainWindow.onCloseRequested(onCloseRequested),
      },
      {
        operation: 'register-tray-quit-listener',
        subscribe: () => mainWindow.onTerminationRequested(onCloseRequested),
      },
    ]

    /* 兑现可能落在清理之后：那就地退订，别留一个悬空的监听。 */
    let disposed = false
    const disposers: Array<() => void> = []

    for (const channel of channels) {
      void channel.subscribe().then(
        (dispose) => {
          if (disposed) {
            dispose()
            return
          }

          disposers.push(dispose)
        },
        (cause: unknown) => {
          if (disposed) {
            return
          }

          reportFailure('WINDOW_CLOSE_LISTENER_UNAVAILABLE', {
            cause,
            operation: channel.operation,
            scope: 'app-shell',
          })
        },
      )
    }

    return () => {
      disposed = true

      for (const dispose of disposers) {
        dispose()
      }

      disposers.length = 0
    }
  }, [mainWindow, onCloseRequested])
}

/*
 * 命令注册表在设置页那一侧的读法。
 *
 * 建在组合根，因为只有这里同时认识 workspace 与 settings —— tools/architecture
 * 里 settings ✗→ workspace 是显式禁止的一条，理由就是这个方向会让两个 feature
 * 互相咬住。设置页拿到的是一份已按平台渲染好的只读列表，它不认识命令注册表，
 * 也就没有第二处解析快捷键的代码。
 *
 * 快照按注册表快照的引用缓存：注册表快照是稳定引用（useSyncExternalStore 的
 * 前提），引用没变就还是上一份 —— 否则 getSnapshot 每次都造新数组，React 会
 * 判定"外部状态一直在变"而无限重渲。这与 keybinding.ts 里那张和弦索引是同一
 * 条纪律。
 */
function createKeybindingCatalog(registry: CommandRegistry): KeybindingCatalog {
  type Snapshot = ReturnType<CommandRegistry['getSnapshot']>

  let source: Snapshot | null = null
  let entries: readonly KeybindingEntry[] = []

  return {
    subscribe: (listener) => registry.subscribe(listener),

    getSnapshot() {
      const snapshot = registry.getSnapshot()

      if (snapshot === source) {
        return entries
      }

      const next: KeybindingEntry[] = []

      for (const command of snapshot) {
        /* 没声明绑定的命令不进这张表：设置页列的是"当前生效的"，不是"全部命令"。 */
        if (command.shortcut === undefined) {
          continue
        }

        next.push({
          id: command.id,
          label: command.label,
          shortcut: formatKeybinding(command.shortcut),
        })
      }

      source = snapshot
      entries = next

      return entries
    },
  }
}
