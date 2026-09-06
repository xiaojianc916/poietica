import { agent as agentDescriptor } from '@poietica/agent-catalog'
import { createAutomationStore } from '@poietica/automation'
import { createConversationRuntime, normalizeWorkspaceRoot } from '@poietica/conversation'
import { ComposerDrafts } from '@poietica/conversation/surface'
import { createPluginStore } from '@poietica/extension'
import { createPreference } from '@poietica/external-store'
import {
  listCustomAgents,
  removeCustomAgent,
  saveCustomAgent,
} from '@poietica/native-bridge/agent/custom'
import { createModelCatalogPort } from '@poietica/native-bridge/agent/models'
import { createAgentSettings } from '@poietica/native-bridge/agent/preferences'
import { automationGateway } from '@poietica/native-bridge/automation'
import { browserHostPort, watchBrowserElementPicked } from '@poietica/native-bridge/browser'
import { capabilityGateway, extensionGateway } from '@poietica/native-bridge/extensions'
import { createSettingsStore } from '@poietica/native-bridge/settings'
import { createAppUpdateController } from '@poietica/native-bridge/update'
import { readAppVersion } from '@poietica/native-bridge/update/version'
import { readTokenDays } from '@poietica/native-bridge/usage'
import { createMainWindowController } from '@poietica/native-bridge/window'
import { createProjectlessWorkspace } from '@poietica/native-bridge/workspace'
import { readDataDirectory } from '@poietica/native-bridge/workspace/data-directory'
import { homeDirectory } from '@poietica/native-bridge/workspace/paths'
import { writeWorkbenchSession } from '@poietica/native-bridge/workspace/session'
import { failureCoordinator, warn } from '@poietica/problem'
import { type CustomAgentStore, ModelCatalogStore, PersonalizationStore } from '@poietica/settings'
import { AppUpdateStore } from '@poietica/update'
import { createCommandRegistry, createWorkbenchSessionController } from '@poietica/workspace'
import { createAuxiliaryPanelStore } from '@poietica/workspace/panels'
import { v7 as uuidv7 } from 'uuid'
import { createDesktopAgentRuntime } from '../assistant/agent-runtime'
import { createAttachmentIntake } from '../assistant/attachment-intake'
import { createConversationEntry } from '../assistant/conversation-entry'
import { createWorkspaceCollapse } from '../assistant/workspace-collapse'
import { reconcileBrowserMcpServer } from '../browser/browser-mcp'
import { createBrowserPickController } from '../browser/browser-pick'
import { NoticeStore } from '../notice/notices'
import { reportFailure } from '../notice/problem-presentation'
import { createWorkspaceLayoutPreference } from '../shell/layout/layout-preference'
import { createWorkspaceLayoutStore } from '../shell/layout/layout-store'
import { createThemeRuntime } from '../window/theme-runtime'
import { createWorkspaceRoots } from '../workspace/roots'
import type { ApplicationRuntime } from './runtime-contract'
import { connectWorkbench } from './workbench-connections'

const MARKETPLACE_URL = 'https://code.kimi.com/kimi-code/plugins/marketplace.json'

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
  const layout = createWorkspaceLayoutStore(createWorkspaceLayoutPreference())
  const composerDrafts = new ComposerDrafts()
  const personalization = new PersonalizationStore(customAgents)
  const auxiliaryPanel = createAuxiliaryPanelStore(browserHostPort)
  const collapsedWorkspaces = createWorkspaceCollapse()
  const notices = new NoticeStore(failureCoordinator)
  const browserPick = createBrowserPickController({
    intake: attachments,
    watch: watchBrowserElementPicked,
    report: (message, cause) => {
      warn(message, { scope: 'browser-pick', cause })
    },
  })

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
      await reconcileBrowserMcpServer(pluginStore)
    })

    backgroundServicesReady = started
    void started.catch(() => {
      if (backgroundServicesReady === started) {
        backgroundServicesReady = null
      }
    })

    return started
  }
  const automationStore = createAutomationStore(automationGateway, {
    createId: uuidv7,
    report: (operation, cause) => {
      warn(operation, { scope: 'automation', cause })
    },
  })

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
  const conversationEntry = createConversationEntry({
    createId: uuidv7,
    readRoot: workspaceRoots.readActive,
    createProjectless: createProjectlessWorkspace,
    open: conversation.threads.create,
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
    own(notices.start())
    own(auxiliaryPanel.start())
    own(browserPick.start())
    own(
      connectWorkbench({
        workspace,
        conversation,
        commands,
        layout,
        auxiliaryPanel,
        conversationEntry,
      }),
    )
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
    own(automationStore.start())
    if (!import.meta.env.DEV) {
      own(updates.start())
    }
  }

  return {
    layout,
    composerDrafts,
    personalization,
    auxiliaryPanel,
    browserPick,
    collapsedWorkspaces,
    notices,
    conversationEntry,
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
        const cleanup = [
          ...cleanups.splice(0).reverse(),
          layout.dispose,
          conversationEntry.dispose,
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
