import { agent as agentDescriptor } from '@poietica/agent-catalog'
import { type AutomationStore, createAutomationStore } from '@poietica/automation'
import type { AttachmentIntake } from '@poietica/conversation'
import {
  type ConversationRuntime,
  createConversationRuntime,
  normalizeWorkspaceRoot,
} from '@poietica/conversation'
import { createPluginStore, type PluginStore } from '@poietica/extension'
import { createPreference } from '@poietica/external-store'
import {
  listCustomAgents,
  removeCustomAgent,
  saveCustomAgent,
} from '@poietica/native-bridge/agent/custom'
import { createModelCatalogPort } from '@poietica/native-bridge/agent/models'
import { createAgentSettings } from '@poietica/native-bridge/agent/preferences'
import { automationGateway } from '@poietica/native-bridge/automation'
import { capabilityGateway, extensionGateway } from '@poietica/native-bridge/extensions'
import { createSettingsStore } from '@poietica/native-bridge/settings'
import { createAppUpdateController } from '@poietica/native-bridge/update'
import { readAppVersion } from '@poietica/native-bridge/update/version'
import { readTokenDays } from '@poietica/native-bridge/usage'
import {
  createMainWindowController,
  type MainWindowController,
} from '@poietica/native-bridge/window'
import { readDataDirectory } from '@poietica/native-bridge/workspace/data-directory'
import { homeDirectory } from '@poietica/native-bridge/workspace/paths'
import { writeWorkbenchSession } from '@poietica/native-bridge/workspace/session'
import { warn } from '@poietica/problem'
import {
  type AgentSettings,
  type CustomAgentStore,
  ModelCatalogStore,
  type SettingsStore,
} from '@poietica/settings'
import { AppUpdateStore } from '@poietica/update'
import type { WorkbenchSessionStore } from '@poietica/workspace'
import {
  type CommandRegistry,
  createCommandRegistry,
  createWorkbenchSessionController,
} from '@poietica/workspace'
import { v7 as uuidv7 } from 'uuid'
import { createAutomationDispatch } from '../automation/dispatch'
import { reportFailure } from '../notice/problem-presentation'
import { createWorkspaceRoots, type WorkspaceRoots } from '../workspace/roots'
import { createDesktopAgentRuntime, type DesktopAgentRuntime } from './agent-runtime'
import { createAttachmentIntake } from './attachment-intake'
import { reconcileAutomationsMcpServer } from './automations-mcp'
import { reconcileBrowserMcpServer } from './browser-mcp'
import { createThemeRuntime, type ThemeRuntime } from './theme-runtime'

const MARKETPLACE_URL = 'https://code.kimi.com/kimi-code/plugins/marketplace.json'

export interface ApplicationRuntime {
  readonly workspaceRoots: WorkspaceRoots
  readonly workspace: WorkbenchSessionStore
  readonly commands: CommandRegistry
  readonly mainWindow: MainWindowController
  readonly theme: ThemeRuntime
  readonly updates: AppUpdateStore
  readonly conversation: ConversationRuntime
  readonly start: () => void
  readonly settings: SettingsStore
  readonly agentConfig: AgentSettings
  /** 模型目录的唯一持有者：默认模型、provider 与密钥的真身都在 agent 进程，这是它的投影。 */
  readonly modelCatalog: ModelCatalogStore
  readonly customAgents: CustomAgentStore
  readonly agent: DesktopAgentRuntime
  readonly attachments: AttachmentIntake
  readonly pluginStore: PluginStore
  readonly automationStore: AutomationStore
  readonly own: (dispose: () => void) => () => void
  /** 这个可执行文件自己的版本号。 */
  readonly appVersion: () => Promise<string>
  /** 这台机器上，这个应用的数据落在哪。关于页面要如实说出它。 */
  readonly dataDirectory: () => Promise<string>
  /** 最近若干天的 token 日账。与上面两个同源同层：账本只有原生侧那一份。 */
  readonly readTokenDays: typeof readTokenDays
  /** Starts non-visual services once; agent launch awaits the same gate. */
  readonly startBackgroundServices: () => void
  readonly dispose: () => Promise<void>
}

export function createApplicationRuntime(restored: string | null): ApplicationRuntime {
  const active = createPreference<string | null>({
    key: 'poietica.workspace.activeRoot',
    fallback: null,
    decode: (raw) => (raw.length > 0 ? normalizeWorkspaceRoot(raw) : null),
    encode: (value) => value,
    onFailure: ({ stage, cause }) => {
      warn(stage === 'read' ? '读不出工作目录偏好' : '写不进工作目录偏好', {
        scope: 'workspace-root',
        cause,
      })
    },
  })
  const home = createPreference<string | null>({
    key: 'poietica.workspace.homeRoot',
    fallback: null,
    decode: (raw) => (raw.length > 0 ? normalizeWorkspaceRoot(raw) : null),
    encode: (value) => value,
    onFailure: ({ stage, cause }) => {
      warn(stage === 'read' ? '读不出主目录偏好' : '写不进主目录偏好', {
        scope: 'workspace-root',
        cause,
      })
    },
  })
  const workspaceRoots = createWorkspaceRoots({
    active,
    home,
    readHome: homeDirectory,
    onHomeFailure: (cause) => {
      warn('无法校准主目录', { scope: 'workspace-root', cause })
    },
  })
  const cleanups: Array<() => void> = []
  let disposed = false
  let started = false
  let disposing: Promise<void> | null = null
  const own = (cleanup: () => void): (() => void) => {
    if (disposed) {
      cleanup()
      return () => undefined
    }
    let active = true
    const release = () => {
      if (!active) {
        return
      }
      active = false
      const index = cleanups.indexOf(release)
      if (index >= 0) {
        cleanups.splice(index, 1)
      }
      cleanup()
    }
    cleanups.push(release)
    return release
  }
  /* The controller owns current state; the database stores its recovery document. */
  const workspace = createWorkbenchSessionController({
    restored,
    persist: writeWorkbenchSession,
    onPersistenceError: (cause) => {
      console.warn('[Poietica] 工作台会话未能存下', cause)
    },
  })
  const commands = createCommandRegistry()
  const mainWindow = createMainWindowController()
  const appUpdate = createAppUpdateController()
  const settings = createSettingsStore()
  const theme = createThemeRuntime({
    mainWindow,
    report: (cause) => {
      reportFailure('WINDOW_SURFACE_SYNC_UNAVAILABLE', {
        cause,
        operation: 'sync-window-surface',
        scope: 'application-runtime',
      })
    },
  })
  const agentConfig = createAgentSettings()
  const customAgents: CustomAgentStore = {
    load: listCustomAgents,
    save: saveCustomAgent,
    remove: removeCustomAgent,
  }

  const attachments = createAttachmentIntake()

  const pluginStore = createPluginStore({
    capability: capabilityGateway,
    gateway: extensionGateway,
    marketplaceUrl: MARKETPLACE_URL,
    now: () => new Date().toISOString(),
  })

  /* First paint and agent launch share one idempotent gate; only agent launch waits for it. */
  let backgroundServicesReady: Promise<void> | null = null
  const ensureBackgroundServices = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error('Application runtime is disposed.'))
    }
    if (backgroundServicesReady !== null) {
      return backgroundServicesReady
    }

    const started = pluginStore.start().then(async () => {
      if (disposed) {
        pluginStore.stop()
        return
      }
      await Promise.all([
        reconcileAutomationsMcpServer(pluginStore),
        reconcileBrowserMcpServer(pluginStore),
      ])
    })

    backgroundServicesReady = started
    void started.catch(() => {
      if (backgroundServicesReady === started) {
        backgroundServicesReady = null
      }
    })

    return started
  }
  const automationStore = createAutomationStore(automationGateway)

  const modelCatalog = new ModelCatalogStore(createModelCatalogPort(), agentDescriptor.id)
  const agent = createDesktopAgentRuntime({
    config: agentConfig,
    modelCatalog,
    cwd: workspaceRoots.readActive,
    mcpReady: ensureBackgroundServices,
  })

  const conversation = createConversationRuntime({
    session: agent.session,
    threads: agent.threads,
    config: agent.sessionConfig,
    usage: agent.sessionUsage,
    posture: agent.permissionPosture,
    capabilities: agent.capabilities(),
    workspace: {
      read: workspaceRoots.readDefault,
      ready: workspaceRoots.ready,
      subscribe: workspaceRoots.subscribeDefault,
    },
    report: {
      session: {
        changeFailed: (cause) => {
          reportFailure('SESSION_CONFIG_CHANGE_REJECTED', { cause, scope: 'assistant' })
        },
        openFailed: (cause) => {
          reportFailure('THREAD_REOPEN_FAILED', { cause, scope: 'assistant' })
        },
      },
      capability: {
        readFailed: (cause) => {
          reportFailure('AGENT_CAPABILITIES_UNREADABLE', { cause, scope: 'assistant' })
        },
        changeFailed: (cause) => {
          reportFailure('AGENT_CONFIG_CHANGE_REJECTED', { cause, scope: 'assistant' })
        },
      },
      workspace: (cause) => {
        reportFailure('THREAD_REOPEN_FAILED', { cause, scope: 'workspace-refresh' })
      },
    },
  })
  const updateCodes = {
    'check-update': 'UPDATE_CHECK_FAILED',
    'download-update': 'UPDATE_DOWNLOAD_FAILED',
    'install-update': 'UPDATE_INSTALL_FAILED',
  } as const
  const updates = new AppUpdateStore(
    appUpdate,
    () => settings.load().then((loaded) => loaded.privacy.updateCheck),
    (operation, cause) => {
      reportFailure(updateCodes[operation], { cause, operation, scope: 'app-update' })
    },
  )
  const automationLifetime = new AbortController()
  const start = (): void => {
    if (disposed) {
      throw new Error('Application runtime is disposed.')
    }
    if (started) {
      return
    }
    started = true
    void workspaceRoots.start()
    conversation.start()
    own(agentConfig.subscribeConfigChanged(conversation.capabilities.refresh))
    let seen = pluginStore.getSnapshot().ownedSkills
    own(
      pluginStore.subscribe(() => {
        const current = pluginStore.getSnapshot().ownedSkills
        if (current !== seen) {
          seen = current
          conversation.capabilities.refresh()
        }
      }),
    )
    own(
      automationStore.start(
        createAutomationDispatch({
          session: agent.session,
          threads: conversation.threads,
          transcripts: conversation.transcripts,
          createId: uuidv7,
          signal: automationLifetime.signal,
        }),
      ),
    )
    if (!import.meta.env.DEV) {
      own(updates.start())
    }
  }

  return {
    workspaceRoots,
    workspace,
    commands,
    mainWindow,
    theme,
    updates,
    conversation,
    start,
    settings,
    agentConfig,
    modelCatalog,
    customAgents,
    agent,
    attachments,
    pluginStore,
    automationStore,
    own,
    appVersion: readAppVersion,
    dataDirectory: readDataDirectory,
    readTokenDays,
    startBackgroundServices: () => {
      void ensureBackgroundServices().catch((cause: unknown) => {
        if (!disposed) {
          reportFailure('AGENT_CAPABILITIES_UNREADABLE', { cause, scope: 'background-services' })
        }
      })
    },

    dispose() {
      if (disposing !== null) {
        return disposing
      }
      disposed = true
      workspaceRoots.dispose()
      disposing = Promise.resolve().then(async () => {
        const failures: unknown[] = []
        automationLifetime.abort(new DOMException('Application stopped.', 'AbortError'))
        const cleanup = [
          ...cleanups.splice(0).reverse(),
          workspace.dispose,
          conversation.dispose,
          updates.dispose,
          () => theme.dispose(),
          () => pluginStore.stop(),
          () => modelCatalog.dispose(),
          () => appUpdate.dispose(),
          () => agent.dispose(),
        ]
        for (const release of cleanup) {
          try {
            await release()
          } catch (cause) {
            failures.push(cause)
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Application shutdown was incomplete.')
        }
      })
      return disposing
    },
  }
}
