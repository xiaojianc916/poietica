import type { AutomationStore } from '@poietica/automation'
import type { AttachmentIntake, ComposerDrafts, ConversationRuntime } from '@poietica/conversation'
import type { PluginStore } from '@poietica/extension'
import type { readTokenDays } from '@poietica/native-bridge/usage'
import type { MainWindowController } from '@poietica/native-bridge/window'
import type { ReviewGateway } from '@poietica/review'
import type {
  AgentSettings,
  CustomAgentStore,
  ModelCatalogStore,
  PersonalizationStore,
  SettingsStore,
} from '@poietica/settings'
import type { TerminalHostPort } from '@poietica/terminal'
import type { AppUpdateStore } from '@poietica/update'
import type { CommandRegistry, WorkbenchSessionStore } from '@poietica/workspace'
import type { AuxiliaryPanelStore } from '@poietica/workspace/panels'
import type { ReactNode } from 'react'
import type { DesktopAgentRuntime } from '../assistant/agent-runtime'
import type { ConversationEntry } from '../assistant/conversation-entry'
import type { WorkspaceCollapse } from '../assistant/workspace-collapse'
import type { BrowserPickController } from '../browser/browser-pick'
import type { NoticeStore } from '../notice/notices'
import type { WorkspaceLayoutStore } from '../shell/layout/layout-store'
import type { ThemeRuntime } from '../window/theme-runtime'
import type { WorkspaceRoots } from '../workspace/roots'

export interface WorkbenchHost {
  readonly review: ReviewGateway
  readonly terminal: TerminalHostPort
  readonly pickWorkspace: () => Promise<string | null>
}

export interface ApplicationRuntime {
  readonly host: WorkbenchHost
  readonly layout: WorkspaceLayoutStore
  readonly composerDrafts: ComposerDrafts
  readonly personalization: PersonalizationStore
  readonly auxiliaryPanel: AuxiliaryPanelStore
  readonly browserPick: BrowserPickController
  readonly collapsedWorkspaces: WorkspaceCollapse
  readonly notices: NoticeStore
  readonly conversationEntry: ConversationEntry
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
  /** 资料库表面渲染器：桌面领域，工作台领域不认它，由组合根装配。 */
  readonly librarySurface: () => ReactNode
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
