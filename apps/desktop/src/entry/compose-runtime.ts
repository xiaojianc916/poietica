import { agent as agentDescriptor } from '@poietica/agent-catalog'
import { type AutomationStore, createAutomationStore } from '@poietica/automation'
import type { AttachmentIntake } from '@poietica/conversation'
import { createPluginStore, type PluginStore } from '@poietica/extension'
import {
  appUpdateController,
  automationGateway,
  capabilityGateway,
  createAgentSettings,
  createMainWindowController,
  createModelCatalogPort,
  createSettingsStore,
  extensionGateway,
  listCustomAgents,
  type MainWindowController,
  readAppVersion,
  readDataDirectory,
  readTokenDays,
  removeCustomAgent,
  saveCustomAgent,
  writeWorkbenchSession,
} from '@poietica/native-bridge'
import {
  type AgentSettings,
  type CustomAgentStore,
  ModelCatalogStore,
  type SettingsStore,
} from '@poietica/settings'
import type { AppUpdateController } from '@poietica/update'
import type { WorkbenchSessionStore } from '@poietica/workspace'
import {
  type CommandRegistry,
  createCommandRegistry,
  createWorkbenchSessionController,
} from '@poietica/workspace'
import { createDesktopAgentRuntime, type DesktopAgentRuntime } from './agent-runtime'
import { createAttachmentIntake } from './attachment-intake'
import { reconcileAutomationsMcpServer } from './automations-mcp'
import { reconcileBrowserMcpServer } from './browser-mcp'
import { activeWorkspaceRoot } from './workspace-root'

/**
 * 市场目录在哪。
 *
 * 官方那一个：上游 apps/kimi-code/src/constant/app.ts 里
 * KIMI_CODE_PLUGIN_MARKETPLACE_URL = `${KIMI_CODE_CDN_BASE}/plugins/marketplace.json`，
 * 而 KIMI_CODE_CDN_BASE 是 https://code.kimi.com/kimi-code；官方文档
 * docs/{zh,en}/configuration/env-vars.md 把同一串逐字写在
 * KIMI_CODE_PLUGIN_MARKETPLACE_URL 一节里。
 *
 * 不是仓库里那份 plugins/marketplace.json：那一份是源码检出时的兜底，条目写的是相对
 * 本地路径，而且它不随发布走 —— 官方发布了什么，只有 CDN 上那一份说得准。
 */
const MARKETPLACE_URL = 'https://code.kimi.com/kimi-code/plugins/marketplace.json'

export interface ApplicationRuntime {
  readonly workspace: WorkbenchSessionStore
  readonly commands: CommandRegistry
  readonly mainWindow: MainWindowController
  readonly appUpdate: AppUpdateController
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
  const cleanups: Array<() => void> = []
  let disposed = false
  const own = (cleanup: () => void): (() => void) => {
    if (disposed) {
      cleanup()
      return () => undefined
    }
    cleanups.push(cleanup)
    let active = true
    return () => {
      if (!active) {
        return
      }
      active = false
      const index = cleanups.indexOf(cleanup)
      if (index >= 0) {
        cleanups.splice(index, 1)
      }
      cleanup()
    }
  }
  /*
   * 工作台的唯一真相在 threads.sqlite3 的 workbench_session 那一行；这里拿到的
   * 是它在这个渲染进程里的唯一投影。变一次写一次，整份覆盖。
   */
  const workspace = createWorkbenchSessionController({
    restored,
    persist: (document) => {
      void writeWorkbenchSession(document).catch((cause: unknown) => {
        /* 写的是整份快照不是增量：这一次没写成，下一次变化会把它整个补上。 */
        console.warn('[Poietica] 工作台会话未能存下', cause)
      })
    },
  })
  const commands = createCommandRegistry()
  const mainWindow = createMainWindowController()
  const appUpdate = appUpdateController
  const settings = createSettingsStore()
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
    if (backgroundServicesReady === null) {
      backgroundServicesReady = Promise.all([
        pluginStore.start(),
        reconcileAutomationsMcpServer(pluginStore),
        reconcileBrowserMcpServer(pluginStore),
      ]).then(() => undefined)
    }
    return backgroundServicesReady
  }
  const automationStore = createAutomationStore(automationGateway)

  const modelCatalog = new ModelCatalogStore(createModelCatalogPort(), agentDescriptor.id)
  const agent = createDesktopAgentRuntime({
    config: agentConfig,
    modelCatalog,
    cwd: activeWorkspaceRoot,
    mcpReady: ensureBackgroundServices,
  })

  return {
    workspace,
    commands,
    mainWindow,
    appUpdate,
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
      void ensureBackgroundServices()
    },

    async dispose() {
      if (disposed) {
        return
      }
      disposed = true
      for (const cleanup of cleanups.splice(0).reverse()) {
        cleanup()
      }
      pluginStore.stop()
      modelCatalog.dispose()
      await agent.dispose()
    },
  }
}
