import { AgentControlsContext, AttachmentIntakeContext } from '@poietica/conversation/surface'
import { failureCoordinator } from '@poietica/problem'
import type { KeybindingCatalog, KeybindingEntry } from '@poietica/settings'
import type { SettingsSection } from '@poietica/settings/ui'
import type { CommandRegistry } from '@poietica/workspace'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ThreadsProvider } from '../assistant/threads-provider'
import { NoticeRegion } from '../notice/notice-region'
import { reportFailure } from '../notice/problem-presentation'
import {
  type ApplicationCommandContext,
  registerApplicationCommands,
} from '../shell/commands/app-commands'
import { CommandPalette, formatKeybinding, useCommandKeybindings } from '../shell/commands/index'
import { UpdateCapsule } from '../update/update-capsule'
import { UpdateRow } from '../update/update-row'
import { useWindowChrome } from '../window/use-window-chrome'
import type { ApplicationRuntime } from './runtime-contract'
import { DesktopWorkspace } from './workspace'

interface AppShellProps {
  readonly runtime: ApplicationRuntime
}

export function AppShell({ runtime }: AppShellProps) {
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false)

  const [isSettingsOpen, setSettingsOpen] = useState(false)

  /*
   * 设置开在哪一页。除了面板里自己翻页，还有外部入口直接指一页（归档横幅的
   * 「筛选已归档会话」），所以这份状态住在组合根，不在设置面板里头。
   */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')

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
      setSettingsSection('general')
      setSettingsOpen(true)
    }
  }, [canOpenSettings])

  /* 归档横幅的问法：「我该怎么看已归档的？」—— 把它放在那一页上，别让它自己找。 */
  const openArchivedChats = useCallback(() => {
    if (canOpenSettings) {
      setSettingsSection('archived')
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
      toggleSidebar: runtime.layout.toggleSidebar,
    }),
    [openAssistantSurface, openSettings, runtime.layout, runtime.workspace, toggleCommandPalette],
  )

  /* 依赖是具体引用，不是整个 runtime：否则任一无关字段变化都会全量重注册。 */
  useEffect(
    () => registerApplicationCommands(runtime.commands, commandContext),
    [commandContext, runtime.commands],
  )

  const [keybindings] = useState(() => createKeybindingCatalog(runtime.commands))

  useCommandKeybindings(runtime.commands)

  return (
    <AttachmentIntakeContext value={runtime.attachments}>
      <AgentControlsContext value={agentControls}>
        <ThreadsProvider
          collapsed={runtime.collapsedWorkspaces}
          conversation={runtime.conversation}
          entry={runtime.conversationEntry}
        >
          <DesktopWorkspace
            agentSession={runtime.agent.session}
            agentSettings={runtime.agentConfig}
            agentSettingsCatalog={runtime.agentSettingsCatalog}
            appVersion={runtime.appVersion}
            automationStore={runtime.automationStore}
            auxiliaryPanel={runtime.auxiliaryPanel}
            commands={runtime.commands}
            composerDrafts={runtime.composerDrafts}
            dataDirectory={runtime.dataDirectory}
            host={runtime.host}
            isSettingsOpen={isSettingsOpen && canOpenSettings}
            isWindowMaximized={isWindowMaximized}
            keybindings={keybindings}
            librarySurface={runtime.librarySurface}
            modelCatalog={runtime.modelCatalog}
            onDeveloperToolsOpen={openDeveloperTools}
            onSettingsClose={closeSettings}
            onSettingsOpen={openSettings}
            onShowArchivedChats={openArchivedChats}
            onThemeChange={runtime.theme.setPreference}
            onWindowClose={closeWindow}
            onWindowMaximize={maximizeWindow}
            onWindowMinimize={minimizeWindow}
            personalization={runtime.personalization}
            plugins={runtime.pluginStore}
            readTokenDays={runtime.readTokenDays}
            settingsSection={settingsSection}
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

          <NoticeRegion store={runtime.notices} />
        </ThreadsProvider>
      </AgentControlsContext>
    </AttachmentIntakeContext>
  )
}

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
          description: command.detail,
          id: command.id,
          label: command.label,
          shortcuts: [formatKeybinding(command.shortcut)],
        })
      }

      source = snapshot
      entries = next

      return entries
    },
  }
}
