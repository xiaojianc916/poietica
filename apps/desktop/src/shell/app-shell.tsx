import type { SessionControlsFailureReport } from '@poietica/conversation'
import { AgentCapabilityStore } from '@poietica/conversation'
import { AgentControlsContext, AttachmentIntakeContext } from '@poietica/conversation-ui'
import { applyThemePreference } from '@poietica/design-system'
import type { PluginsViewModel } from '@poietica/extension'
import type { MainWindowController } from '@poietica/native-bridge'
import { failureCoordinator } from '@poietica/problem'
import type { KeybindingCatalog, KeybindingEntry } from '@poietica/settings'
import { type AppUpdateOperation, AppUpdateStore } from '@poietica/update'
import type { CommandRegistry } from '@poietica/workspace'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ApplicationRuntime } from '../entry/compose-runtime'
import { PluginLoader, pluginStore } from '../entry/plugin-runtime'
import { NoticeRegion } from '../notice/notice-region'
import { type ApplicationFailureCode, reportFailure } from '../notice/problem-presentation'
import { useWindowChrome } from '../window/use-window-chrome'
import { AutomationDispatcher } from './automation-runtime'
import { CommandPalette, formatKeybinding, useCommandKeybindings } from './commands'
import {
  type ApplicationCommandContext,
  registerApplicationCommands,
} from './commands/app-commands'
import { ConversationCommands } from './conversation-commands'
import { ThreadsProvider } from './threads-provider'
import { UpdateCapsule } from './update-capsule'
import { UpdateRow } from './update-row'
import { type AppCapabilities, WorkspaceContainer } from './workspace-container'
import { workspaceLayoutStore } from './workspace-layout-store'

/*
 * 开发构建不检查更新：开发跑的版本号来自工作区，任何已发布版本都比它新，结果是
 * 每六小时提示一次一个装不上的更新。这个判断是构建期常量，放在模块级，生产构建
 * 里整个分支会被直接消掉；native-bridge 是适配层，不该知道自己被谁怎么打包。
 */
const CHECKS_UPDATES = !import.meta.env.DEV
/* 三个动作三句话：一次检查失手不该顶着「更新没能下载完成」上屏。 */
const UPDATE_FAILURE_CODES = {
  'check-update': 'UPDATE_CHECK_FAILED',
  'download-update': 'UPDATE_DOWNLOAD_FAILED',
  'install-update': 'UPDATE_INSTALL_FAILED',
} as const satisfies Record<AppUpdateOperation, ApplicationFailureCode>

/* 拆掉 runtime 是启动期的事，不属于界面：这里只把那一柄拿掉。 */
type AppShellRuntime = Omit<ApplicationRuntime, 'dispose'>

interface AppShellProps {
  readonly runtime: AppShellRuntime
}

export function AppShell({ runtime }: AppShellProps) {
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false)

  const [isSettingsOpen, setSettingsOpen] = useState(false)

  /* 现在用哪一家 agent。能力表按它取，见下面那个 effect。 */
  const agentId = useSyncExternalStore(
    runtime.agent.subscribeAgent,
    runtime.agent.getAgentId,
    runtime.agent.getAgentId,
  )

  const {
    isMaximized: isWindowMaximized,
    minimize: minimizeWindow,
    toggleMaximize: maximizeWindow,
  } = useWindowChrome(runtime.mainWindow)

  const failureSnapshot = useSyncExternalStore(
    failureCoordinator.subscribe,
    failureCoordinator.getSnapshot,
    failureCoordinator.getSnapshot,
  )

  /*
   * 降级判断只在这里派生一次，并且这次真的是稳定引用。
   *
   * 依赖是三个布尔，不是那张 Map：FailureCoordinator.publish() 每次都
   * degradedFeatures: new Map(...)，而 publish 也走 recoverable 上报与 dismiss。
   * 按 Map 的引用记忆化，等于任何一次与降级无关的失败都会换掉 capabilities,
   * 把工作区容器下游的记忆化全部作废。
   */
  const degraded = failureSnapshot.degradedFeatures

  const canOpenSettings = !degraded.has('settings')
  const canOpenDeveloperTools = !degraded.has('developer-tools')
  const canUseWindowControls = !degraded.has('window-controls')

  const capabilities = useMemo<AppCapabilities>(
    () => ({
      developerTools: canOpenDeveloperTools,
      settings: canOpenSettings,
      windowControls: canUseWindowControls,
    }),
    [canOpenDeveloperTools, canOpenSettings, canUseWindowControls],
  )

  /*
   * 更新状态在这里落地，一个进程一份：菜单里那一行只是投影，菜单每次开合都是一次
   * 卸载重挂，状态不能待在它身上。
   */
  /*
   * 用 useState 的初始化函数，不是 useMemo。
   *
   * useMemo 是性能优化，React 允许丢弃缓存重算；这个 store 有身份（start() 返回
   * 退订），丢一次缓存就多一个实例、多一份订阅，「一个进程一份」当场失效。
   * runtime 由 bootstrap 造一次并作为 prop 传进来（见 entry/mount.tsx），
   * 原来的依赖数组本就永不变化，所以这是等价替换，且拿到了创建一次的保证。
   */
  const [updates] = useState(
    () =>
      new AppUpdateStore(
        runtime.appUpdate,
        () =>
          runtime.settings
            .load()
            .then((loaded) => loaded.privacy.updateCheck)
            .catch(() => false),
        (operation, cause) => {
          reportFailure(UPDATE_FAILURE_CODES[operation], { cause, operation, scope: 'app-update' })
        },
      ),
  )

  /* 订阅与退订成对交给 effect，与 ThreadsStore.start 同一条纪律。 */
  useEffect(() => {
    if (!CHECKS_UPDATES) {
      return undefined
    }

    return updates.start()
  }, [updates])

  const toggleCommandPalette = useCallback(() => {
    setCommandPaletteOpen((open) => !open)
  }, [])

  const openAssistantSurface = useCallback(() => {
    runtime.workspace.openSurface({ surfaceId: 'ai' })
  }, [runtime.workspace])

  const openSettings = useCallback(() => {
    if (capabilities.settings) {
      setSettingsOpen(true)
    }
  }, [capabilities.settings])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
  }, [])

  /*
   * 关闭窗口就是关闭窗口。
   *
   * 此前这里要经过一个三态终止协调器，它唯一的存在理由是「退出前确认未保存的
   * 工作」——文档域移除之后没有任何东西需要被确认，于是那台状态机连同它的
   * 确认弹窗一起消失，不留一个恒返回 close-now 的空壳。
   */
  const closeWindow = useCallback(() => {
    void runtime.mainWindow.forceClose()
  }, [runtime.mainWindow])

  const openDeveloperTools = useCallback(() => {
    if (!capabilities.developerTools) {
      return
    }

    void runtime.mainWindow.openDeveloperTools().catch((cause: unknown) => {
      reportFailure('DEVELOPER_TOOLS_UNAVAILABLE', {
        scope: 'app-shell',
        operation: 'open-developer-tools',
        cause,
      })
    })
  }, [capabilities.developerTools, runtime.mainWindow])

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

  /*
   * 主题在这里只校正，不建立。
   *
   * 建立在 main.tsx —— data-theme 缺席时设计系统令牌解成浅色，所以它必须早于
   * 第一帧。这一趟是异步的，回来时第一帧早画完了：只有存下的选择与 system 不
   * 同的人会看到一次切换，而那是两个都成立的状态之间的切换。删掉 main.tsx 那
   * 一处会静默把冷启动的白闪带回来。
   */
  useEffect(() => {
    let active = true

    void runtime.settings.load().then(
      (settings) => {
        if (!active) {
          return
        }

        applyThemePreference(settings.theme)
      },
      (cause: unknown) => {
        if (!active) {
          return
        }

        reportFailure('SETTINGS_LOAD_FAILED', {
          scope: 'app-shell',
          operation: 'load-settings',
          cause,
        })
      },
    )

    return () => {
      active = false
    }
  }, [runtime.settings])

  /*
   * 这一家 agent 提供哪些可调项，一个进程一份。
   *
   * useState 的初始化函数，不是 useMemo：useMemo 是性能优化，React 允许丢弃缓存
   * 重算，而这台 store 有身份（start() 返回退订），丢一次缓存就多一个实例、多一份
   * 订阅。理由与上面那台更新 store 逐字相同。
   *
   * 读不到和改不动分开报：一次被拒的改动顶着「没能读到可用的模型，去看看密钥填了
   * 没有」上屏，唯一的效果是让人去检查一把本来就是对的钥匙。这两个回调是给日志与
   * 降级用的；屏幕上那一格读的是 store 快照里的 failure，因为它要能被再试一次。
   */
  const [agentControls] = useState(
    () =>
      new AgentCapabilityStore({
        posture: runtime.agent.permissionPosture,

        report: {
          readFailed: (cause) => {
            reportFailure('AGENT_CAPABILITIES_UNREADABLE', {
              scope: 'app-shell',
              operation: 'read-capabilities',
              cause,
            })
          },

          changeFailed: (cause) => {
            reportFailure('AGENT_CONFIG_CHANGE_REJECTED', {
              scope: 'app-shell',
              operation: 'change-capability',
              cause,
            })
          },
        },
      }),
  )

  /*
   * 会话那一侧的失败也走同一条上报路。
   *
   * 与上面那台能力表 store 的 report 是同一条规矩：屏幕上那一格读的是各自快照里的
   * failure（它要能被再试一次），而「因为什么」到这里汇成降级与日志。同一件事在
   * agent scope 与会话 scope 上不该有两套错误规则。
   *
   * 记忆化，因为它是 ThreadsProvider 的 prop：每次渲染换一个对象，等于每次都换掉
   * 那棵子树的输入。reportFailure 是模块级函数，依赖为空。
   */
  const sessionControlsReport = useMemo<SessionControlsFailureReport>(
    () => ({
      changeFailed: (cause) => {
        reportFailure('SESSION_CONFIG_CHANGE_REJECTED', {
          scope: 'assistant',
          operation: 'change-session-config',
          cause,
        })
      },

      openFailed: (cause) => {
        reportFailure('THREAD_REOPEN_FAILED', {
          scope: 'assistant',
          operation: 'reopen-thread',
          cause,
        })
      },
    }),
    [],
  )

  /*
   * 端口与重问的通知同源同寿，所以它们是同一个 effect 的一次装载与一次清理。
   *
   * 端口按「用哪一家 agent」建，设置页动过它的配置之后那张表就不再作数。装载几次
   * 就退订几次，不可能配不平 —— 与 ThreadsStore.start 同一条纪律。
   */
  useEffect(() => {
    const stop = agentControls.start(runtime.agent.capabilities(agentId))

    const stopWatchingConfig = runtime.agentConfig.subscribeConfigChanged(agentControls.refresh)

    return () => {
      stopWatchingConfig()
      stop()
    }
  }, [agentControls, agentId, runtime.agent, runtime.agentConfig])

  /*
   * 技能写进 skills/ 之后（装、卸、开关），让名册重问一次：名册只回答这个会话装载了
   * 没有，而写路径只改目录不改名册 —— 不重问，能力表就停在旧账上。
   *
   * 订的是快照里本机名单的引用：写失败不动名单，也就不触发重问。首扫那一次只记
   * 基线 —— 名册自己的首读在 start() 里，不缺这一次。
   */
  useEffect(() => {
    let seen: PluginsViewModel['ownedSkills'] | undefined

    return pluginStore.subscribe(() => {
      const owned = pluginStore.getSnapshot().ownedSkills

      if (seen !== undefined && owned !== seen) {
        agentControls.refresh()
      }

      seen = owned
    })
  }, [agentControls])

  /*
   * 目录一个进程一份，理由与上面两台 store 逐字相同：useState 的初始化函数给
   * 的是"创建一次"的保证，useMemo 只是性能优化，React 允许丢弃缓存重算。
   */
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
        <ThreadsProvider agent={runtime.agent} report={sessionControlsReport}>
          {/*
           * 无渲染产出，只是让「到期时做什么」与应用同寿；表本身在原生侧走。放在
           * ThreadsProvider 之内是硬要求：一次运行要开出一条对话，而开对话的动作出
           * 自这个 provider。
           */}
          <AutomationDispatcher session={runtime.agent.session} />

          {/* 同样无渲染产出：让插件的装载与应用同寿。 */}
          <PluginLoader />

          {/*
          同样无渲染产出：把会话列表贡献进命令注册表，于是搜索框里第一组就是
          「聊天」。必须在 ThreadsProvider 之内 —— 它读的就是那份列表。
        */}
          <ConversationCommands registry={runtime.commands} workspace={runtime.workspace} />

          <WorkspaceContainer
            agentConfigStore={runtime.agentConfig}
            agentSession={runtime.agent.session}
            appVersion={runtime.appVersion}
            capabilities={capabilities}
            commands={runtime.commands}
            customAgentStore={runtime.customAgents}
            dataDirectory={runtime.dataDirectory}
            isSettingsOpen={isSettingsOpen && capabilities.settings}
            isWindowMaximized={isWindowMaximized}
            keybindings={keybindings}
            onDeveloperToolsOpen={openDeveloperTools}
            onSettingsClose={closeSettings}
            onSettingsOpen={openSettings}
            onWindowClose={closeWindow}
            onWindowMaximize={maximizeWindow}
            onWindowMinimize={minimizeWindow}
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
