import type { SessionControlsFailureReport } from '@poietica/agent'
import { AgentCapabilityStore } from '@poietica/agent'
import type { AcpAgentDescriptor } from '@poietica/agent-catalog'
import type { AgentDialect, AttachmentIntake } from '@poietica/agent-ui'
import {
  AgentControlsContext,
  AgentDialectContext,
  AttachmentIntakeContext,
} from '@poietica/agent-ui'
import type { AppUpdateController, MainWindowController } from '@poietica/desktop-adapters'
import { AppUpdateStore } from '@poietica/desktop-adapters'
import type { AgentConfigStore, SettingsStore } from '@poietica/settings'
import { applyThemePreference } from '@poietica/ui'
import type { CommandRegistry, WorkbenchSessionStore } from '@poietica/workspace'
import { CommandPalette, useCommandKeybindings, workspaceLayoutStore } from '@poietica/workspace'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { type ApplicationCommandContext, registerApplicationCommands } from '../app-commands'
import type { DesktopAgentRuntime } from '../assistant/agent-runtime'
import { ThreadsProvider } from '../assistant/threads-provider'
import { AutomationDispatcher } from '../automations/automation-runtime'
import { useWindowChrome } from '../chrome/use-window-chrome'
import { reportFailure } from '../failures/application-policy'
import { failureCoordinator } from '../failures/coordinator'
import { UiFeedbackRegion } from '../feedback/ui-feedback'
import { UpdateCapsule } from '../feedback/update-capsule'
import { PluginLoader } from '../plugins/plugin-runtime'
import { ConversationCommands } from '../workbench/conversation-commands'
import { type AppCapabilities, WorkspaceContainer } from '../workbench/workspace-container'

/*
 * 开发构建不检查更新：开发跑的版本号来自工作区，任何已发布版本都比它新，结果是
 * 每六小时提示一次一个装不上的更新。这个判断是构建期常量，放在模块级，生产构建
 * 里整个分支会被直接消掉；desktop-adapters 是适配层，不该知道自己被谁怎么打包。
 */
const CHECKS_UPDATES = !import.meta.env.DEV

/**
 * 对面那家 agent 的方言。
 *
 * 会话本来就是拿这份档案建起来的(见 assistant/agent-session.ts),
 * 所以「跟谁说话」和「它怎么说话」出自同一个答案,不会各说各的。
 * 界面包不认识名单:这一层拿到的已经是一份档案,不是一次查名单。
 */
function dialectOf(agent: AcpAgentDescriptor): AgentDialect {
  return {
    optionLabels: agent.optionLabels,
    questions: agent.questionDialect === undefined ? [] : [agent.questionDialect],
  }
}

export interface AppShellRuntime {
  readonly workspace: WorkbenchSessionStore
  readonly commands: CommandRegistry
  readonly mainWindow: MainWindowController
  readonly appUpdate: AppUpdateController
  readonly settings: SettingsStore
  readonly agentConfig: AgentConfigStore
  readonly agent: DesktopAgentRuntime
  readonly attachments: AttachmentIntake
  readonly appVersion: () => Promise<string>
  readonly dataDirectory: () => Promise<string>
}

export interface AppShellProps {
  readonly runtime: AppShellRuntime
}

export function AppShell({ runtime }: AppShellProps) {
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false)

  const [isSettingsOpen, setSettingsOpen] = useState(false)

  /*
   * 方言跟着「现在用哪一家」走。
   *
   * 此前它是一个模块常量，取自注册表的第一行：设置页换了 agent，权限按钮上的
   * 文案与认题的正则仍是上一家的 —— 画得出来，只是全错，而且不报任何错。
   */
  const agentId = useSyncExternalStore(
    runtime.agent.subscribeAgent,
    runtime.agent.getAgentId,
    runtime.agent.getAgentId,
  )

  const dialect = useMemo(
    () => dialectOf(runtime.agent.descriptor(agentId)),
    [agentId, runtime.agent],
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
   * 更新状态在这里落地，一个进程一份。
   *
   * 它必须比那枚胶囊活得久：胶囊挂在 sidebarFooterSlot 上，而那个插槽在设置态会被
   * sidebarOverride 顶替，React 按位置协调，等于一次卸载重挂。状态放在这一层，切设
   * 置页就只是换个地方把同一份状态再画一遍。
   */
  /*
   * 用 useState 的初始化函数，不是 useMemo。
   *
   * useMemo 是性能优化，React 允许丢弃缓存重算；这个 store 有身份（start() 返回
   * 退订），丢一次缓存就多一个实例、多一份订阅，「一个进程一份」当场失效。
   * runtime 由 bootstrap 造一次并作为 prop 传进来（见 bootstrap/react-root.tsx),
   * 原来的依赖数组本就永不变化，所以这是等价替换，且拿到了创建一次的保证。
   */
  const [updates] = useState(
    () =>
      new AppUpdateStore(runtime.appUpdate, runtime.settings, (operation, cause) => {
        reportFailure('UPDATE_DOWNLOAD_FAILED', { cause, operation, scope: 'app-update' })
      }),
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
   * 订阅。理由与上面那枚更新胶囊逐字相同。
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
      <AgentDialectContext value={dialect}>
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
              dataDirectory={runtime.dataDirectory}
              isSettingsOpen={isSettingsOpen && capabilities.settings}
              isWindowMaximized={isWindowMaximized}
              onDeveloperToolsOpen={openDeveloperTools}
              onSettingsClose={closeSettings}
              onSettingsOpen={openSettings}
              onWindowClose={closeWindow}
              onWindowMaximize={maximizeWindow}
              onWindowMinimize={minimizeWindow}
              settingsStore={runtime.settings}
              sidebarFooterSlot={<UpdateCapsule store={updates} />}
              workspace={runtime.workspace}
            />

            <CommandPalette
              onOpenChange={setCommandPaletteOpen}
              open={isCommandPaletteOpen}
              registry={runtime.commands}
            />

            <UiFeedbackRegion />
          </ThreadsProvider>
        </AgentControlsContext>
      </AgentDialectContext>
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
