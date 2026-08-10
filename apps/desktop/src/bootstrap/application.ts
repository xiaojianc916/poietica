import type { AttachmentIntake } from '@poietica/agent-ui'
import {
  type AgentConfigStore,
  type AppUpdateController,
  createAppUpdateController,
  createAttachmentIntake,
  createDesktopAgentConfigStore,
  createDesktopSettingsStore,
  createMainWindowController,
  type MainWindowController,
  readAppVersion,
  readDataDirectory,
  type SettingsStore,
} from '@poietica/desktop-adapters'
import type { WorkbenchSessionStore } from '@poietica/workspace'
import {
  type CommandRegistry,
  createCommandRegistry,
  createWorkbenchSessionController,
} from '@poietica/workspace'
import { createDesktopAgentRuntime, type DesktopAgentRuntime } from '../assistant/agent-runtime'
import { reportFailure } from '../failures/application-policy'
import { failureCoordinator } from '../failures/coordinator'
import { activeMcpServers } from '../plugins/plugin-runtime'
import { activeWorkspaceRoot } from '../workspace-root'

export interface ApplicationRuntime {
  readonly workspace: WorkbenchSessionStore
  readonly commands: CommandRegistry
  readonly mainWindow: MainWindowController
  readonly appUpdate: AppUpdateController
  readonly settings: SettingsStore
  readonly agentConfig: AgentConfigStore
  readonly agent: DesktopAgentRuntime
  readonly attachments: AttachmentIntake
  /** 这个可执行文件自己的版本号。关于页面此前写死了它。 */
  readonly appVersion: () => Promise<string>
  /** 这台机器上，这个应用的数据落在哪。关于页面要如实说出它。 */
  readonly dataDirectory: () => Promise<string>
  readonly dispose: () => Promise<void>
}

export function createApplicationRuntime(): ApplicationRuntime {
  const workspace = createWorkbenchSessionController()
  const commands = createCommandRegistry()
  const mainWindow = createMainWindowController()
  const appUpdate = createAppUpdateController()
  const settings = createDesktopSettingsStore()
  const agentConfig = createDesktopAgentConfigStore()

  const attachments = createAttachmentIntake()
  const agent = createDesktopAgentRuntime({
    config: agentConfig,
    cwd: activeWorkspaceRoot,
    mcpServers: activeMcpServers,
    onSelectionFailure: (cause) => {
      reportFailure('AGENT_SELECTION_UNAVAILABLE', {
        scope: 'application-runtime',
        operation: 'load-agent-selection',
        cause,
      })
    },
    onSelectionReady: () => {
      failureCoordinator.resolveScope({
        kind: 'operation',
        operation: 'load-agent-selection',
      })
    },
  })

  return {
    workspace,
    commands,
    mainWindow,
    appUpdate,
    settings,
    agentConfig,
    agent,
    attachments,
    appVersion: readAppVersion,
    dataDirectory: readDataDirectory,

    async dispose() {
      await agent.dispose()
    },
  }
}
