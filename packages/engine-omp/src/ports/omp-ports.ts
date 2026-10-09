import type { AgentEngine } from '@poietica/engine'
import type { Logger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import type { OmpModelRegistry, OmpSessionLike } from '../omp-context'
import type { SettingsScope } from '../settings-access'
import { OmpMcpPort } from './mcp'
import { registryPortOf } from './model-helpers'
import { OmpModelsPort } from './models'
import { CustomProvidersFile, modelsFilePath } from './models-file'
import { OmpPluginsPort } from './plugins'
import { OmpSessionFilesPort } from './session-files'
import { OmpSettingsPort } from './settings'
import { OmpSkillsPort } from './skills'

export interface OmpPortsOptions {
  readonly layout: DataLayout
  readonly logger: Logger
  readonly root: SettingsScope
  /** omp 的 ModelRegistry：端口只认收窄后的 RegistryPort（model-helpers 的 registryPortOf 转） */
  readonly registry: OmpModelRegistry
  readonly authStorage: object
  readonly relayPort: number
  /** 活着的会话：MCP 状态要按名汇总它们各自的 mcpManager（12 页 §3.14） */
  readonly sessions: Set<OmpSessionLike>
}

/** 六个端口一次组装好（12 页 §10）。端口之间不互相依赖，只依赖 omp 对象与设置句柄。 */
export async function ompPorts(o: OmpPortsOptions): Promise<{
  sessionFiles: AgentEngine['sessionFiles']
  models: AgentEngine['models']
  settings: AgentEngine['settings']
  skills: AgentEngine['skills']
  mcp: AgentEngine['mcp']
  plugins: AgentEngine['plugins']
  /** MCP 端口的增量重报（接口上没有这一格：只有实现知道什么时候该重报） */
  mcpRefreshStatus: () => void
}> {
  // 会话目录：<ompAgentDir>/sessions（12 页 §10.1 / docs/omp-sdk-reference.md §N）
  const dirs = await import('@oh-my-pi/pi-utils/dirs')
  const sessionDir = dirs.getSessionsDir(o.layout.ompAgentDir)
  // omp 的 ModelRegistry 有 reload：写完 models.yml 之后让它重读
  const reload = async (): Promise<void> => {
    const registry = o.registry as { reload?: () => Promise<void> }
    await registry.reload?.()
  }
  const customProviders = new CustomProvidersFile({
    file: modelsFilePath(o.layout.ompAgentDir),
    logger: o.logger,
    reload,
  })
  const mcp = new OmpMcpPort({ ompAgentDir: o.layout.ompAgentDir, sessions: o.sessions, logger: o.logger })
  return {
    sessionFiles: new OmpSessionFilesPort({ sessionDir, logger: o.logger }),
    models: new OmpModelsPort({
      registry: registryPortOf(o.registry),
      credentials: (o.authStorage as { credentials: never }).credentials,
      root: o.root,
      customProviders,
      logger: o.logger,
      reload,
    }),
    /*
     * 设置端口也收模型目录：sharpshooter.model 的选项表要现算（那一格在 schema 里只是
     * string）。与 ModelsPort 用**同一个 registry** —— 另写一份「有钥匙的模型」就是第二个事实。
     */
    settings: new OmpSettingsPort({ root: o.root, logger: o.logger, registry: registryPortOf(o.registry) }),
    skills: new OmpSkillsPort({ root: o.root, ompAgentDir: o.layout.ompAgentDir, logger: o.logger }),
    mcp,
    mcpRefreshStatus: () => mcp.refreshStatus(),
    plugins: new OmpPluginsPort({ cwd: o.layout.coreCwd, logger: o.logger }),
  }
}
