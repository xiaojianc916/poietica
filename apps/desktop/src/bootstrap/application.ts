import type { AttachmentIntake } from '@poietica/conversation-ui'
import {
  createMainWindowController,
  listCustomAgents,
  type MainWindowController,
  readAppVersion,
  readDataDirectory,
  removeCustomAgent,
  saveCustomAgent,
  writeWorkbenchSession,
} from '@poietica/native-bridge'
import type { AgentConfigStore, CustomAgentStore, SettingsStore } from '@poietica/settings'
import type { WorkbenchSessionStore } from '@poietica/workspace'
import {
  type CommandRegistry,
  createCommandRegistry,
  createWorkbenchSessionController,
} from '@poietica/workspace'
import { createDesktopAgentRuntime, type DesktopAgentRuntime } from '../assistant/agent-runtime'
import { reportFailure } from '../failures/application-policy'
import { failureCoordinator } from '../failures/coordinator'
import { type AppUpdateController, createAppUpdateController } from '../updates/app-update'
import { activeWorkspaceRoot } from '../workspace-root'
import { createDesktopAgentConfigStore } from './agent-config-store'
import { createAttachmentIntake } from './attachment-intake'
import { createDesktopSettingsStore } from './settings-store'

export interface ApplicationRuntime {
  readonly workspace: WorkbenchSessionStore
  readonly commands: CommandRegistry
  readonly mainWindow: MainWindowController
  readonly appUpdate: AppUpdateController
  readonly settings: SettingsStore
  readonly agentConfig: AgentConfigStore
  readonly customAgents: CustomAgentStore
  readonly agent: DesktopAgentRuntime
  readonly attachments: AttachmentIntake
  /** 这个可执行文件自己的版本号。 */
  readonly appVersion: () => Promise<string>
  /** 这台机器上，这个应用的数据落在哪。关于页面要如实说出它。 */
  readonly dataDirectory: () => Promise<string>
  readonly dispose: () => Promise<void>
}

export function createApplicationRuntime(restored: string | null): ApplicationRuntime {
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
  const appUpdate = createAppUpdateController()
  const settings = createDesktopSettingsStore()
  const agentConfig = createDesktopAgentConfigStore()
  const customAgents: CustomAgentStore = {
    load: listCustomAgents,
    save: saveCustomAgent,
    remove: removeCustomAgent,
  }

  const attachments = createAttachmentIntake()
  const agent = createDesktopAgentRuntime({
    config: agentConfig,
    cwd: activeWorkspaceRoot,
    onSelectionFailure: (cause) => {
      reportFailure('AGENT_SELECTION_UNAVAILABLE', {
        scope: 'application-runtime',
        operation: 'load-agent-selection',
        cause,
      })
    },
    onSelectionReady: () => {
      failureCoordinator.resolveOperation('load-agent-selection')
    },
  })

  return {
    workspace,
    commands,
    mainWindow,
    appUpdate,
    settings,
    agentConfig,
    customAgents,
    agent,
    attachments,
    appVersion: readAppVersion,
    dataDirectory: readDataDirectory,

    async dispose() {
      await agent.dispose()
    },
  }
}
