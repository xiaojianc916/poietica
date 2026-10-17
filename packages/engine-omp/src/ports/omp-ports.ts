import { getOAuthProviders } from '@oh-my-pi/pi-ai/oauth'
import { getProviderDefinition } from '@oh-my-pi/pi-ai/registry'
import { resolveModelRoleValue } from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import {
  formatModelRoleAlias,
  getKnownRoleIds,
  getRoleInfo,
  MODEL_ROLES,
  roleCandidatePool,
} from '@oh-my-pi/pi-coding-agent/config/model-roles'
import type { AgentEngine } from '@poietica/engine'
import type { Logger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import type { OmpModelRegistry, OmpSessionLike } from '../omp-context'
import type { SettingsScope } from '../settings-access'
import { OmpMcpPort } from './mcp'
import { registryPortOf } from './model-helpers'
import { OmpModelsPort, type OmpOAuth, type OmpRoles } from './models'
import { CustomProvidersFile, modelsFilePath } from './models-file'
import { OmpPluginsPort } from './plugins'
import { roleTextOf } from './role-catalog'
import { OmpSessionFilesPort } from './session-files'
import { OmpSettingsPort } from './settings'
import { settingsInstanceOf } from './settings-writes'
import { OmpSkillsPort } from './skills'

export interface OmpPortsOptions {
  readonly layout: DataLayout
  readonly logger: Logger
  readonly root: SettingsScope
  /** omp 的 ModelRegistry：端口只认收窄后的 RegistryPort（model-helpers 的 registryPortOf 转） */
  readonly registry: OmpModelRegistry
  readonly authStorage: object
  readonly relayPort: number
  /** 活着的会话：MCP 状态要按名汇总它们各自的 mcpManager */
  readonly sessions: Set<OmpSessionLike>
}

/** 六个端口一次组装好。端口之间不互相依赖，只依赖 omp 对象与设置句柄。 */
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
  // 会话目录：<ompAgentDir>/sessions（见 docs/omp-sdk-reference.md §N）
  const dirs = await import('@oh-my-pi/pi-utils/dirs')
  const sessionDir = dirs.getSessionsDir(o.layout.ompAgentDir)
  /*
   * omp 知识 #18：ModelRegistry **没有** `reload()` —— 旧代码的 `registry.reload?.()` 每次都
   * 静默落到 undefined，写完 models.yml 之后内存目录保持旧样，用户新加的服务商要等下次启动才出现。
   * 官方那条路是 refreshIfStale()（按 models.yml 的 mtime 决定要不要重读，目录没变就不动）。
   */
  const reload = async (): Promise<void> => {
    await o.registry.refreshIfStale()
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
      oauth: ompOAuthOf(o.authStorage as OmpAuthStorageWithOAuth, getOAuthProviders, getProviderDefinition),
      roles: ompRolesOf(o.root, o.registry),
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

/** omp 的角色目录：清单、名字、候选都直接问 config/model-roles（与 omp 自己的 /model 角色面板同一份事实） */
export function ompRolesOf(root: SettingsScope, registry: Pick<OmpModelRegistry, 'getAvailable'>): OmpRoles {
  const settings = () => settingsInstanceOf(root)
  return {
    known: () => getKnownRoleIds(settings()),
    info: (role) => {
      const info = getRoleInfo(role, settings())
      /* 名字没被 modelTags 改过（还是 omp 内置那一个）才换中文；用户自己起的名字原样交回 */
      const builtinName = (MODEL_ROLES as Record<string, { name: string } | undefined>)[role]?.name
      const text = roleTextOf(role, info.name === builtinName)
      return {
        name: text.name ?? info.name,
        description: text.description,
        section: info.section === 'kind' ? 'kind' : 'chat',
      }
    },
    candidates: (role) => roleCandidatePool(role, settings(), registry as never),
    auto: (role) => {
      const s = settings()
      const pool = roleCandidatePool(role, s, registry as never)
      return pool.length === 0
        ? null
        : (resolveModelRoleValue(formatModelRoleAlias(role), pool, { settings: s }).model ?? null)
    },
  }
}

/** omp AuthStorage 里账号登录用得着的几格（credentials 的 OAuth 那几行 / oauth.login），签名照 pi-ai auth/types.ts */
interface OmpAuthStorageWithOAuth {
  readonly credentials: {
    hasOAuth(provider: string): boolean
    getOAuth(provider: string): { readonly email?: string; readonly orgName?: string } | undefined
    list(provider: string): readonly { readonly id: number; readonly credential: { readonly type: string } }[]
    removeById(provider: string, credentialId: number): Promise<boolean>
  }
  readonly oauth: { login: OmpOAuth['login'] }
}

/** pi-ai 的 ProviderDefinition 里判得出「是不是账号授权」的三格 */
interface LoginDefinition {
  readonly refreshToken?: unknown
  readonly callbackPort?: number
  readonly pasteCodeFlow?: boolean
}

/**
 * 这条登录是哪一种：有刷新令牌的是账号授权（omp 存成 OAuth 凭据）；没有刷新令牌但有本机回调端口或粘贴授权码流程的，
 * 是在浏览器里授权、换回一把 API Key（omp 存成 api_key）；两样都没有的那几十家，「登录」只是让人贴一把 API Key。
 * 插件注册的登录查不到定义，按账号授权算 —— 它们实现的是 OAuthProviderInterface。
 */
export function loginKindOf(definition: LoginDefinition | undefined): 'account' | 'browser-key' | 'manual-key' {
  if (definition === undefined || definition.refreshToken !== undefined) return 'account'
  if (definition.callbackPort !== undefined || definition.pasteCodeFlow === true) return 'browser-key'
  return 'manual-key'
}

function ompOAuthOf(
  storage: OmpAuthStorageWithOAuth,
  providers: () => readonly { id: string; name: string; available: boolean; storeCredentialsAs?: string }[],
  definitionOf: (id: string) => LoginDefinition | undefined,
): OmpOAuth {
  return {
    providers: () => providers().map((entry) => ({ ...entry, kind: loginKindOf(definitionOf(entry.id)) })),
    authenticated: (provider) => storage.credentials.hasOAuth(provider),
    account: (provider) => {
      const credential = storage.credentials.getOAuth(provider)
      return credential?.email ?? credential?.orgName ?? null
    },
    login: (providerId, ctrl) => storage.oauth.login(providerId, ctrl),
    logout: async (provider) => {
      for (const row of storage.credentials.list(provider)) {
        if (row.credential.type === 'oauth') await storage.credentials.removeById(provider, row.id)
      }
    },
  }
}
