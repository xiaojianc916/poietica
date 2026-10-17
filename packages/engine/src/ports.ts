import type { Event } from '@poietica/foundation'
import type { z } from 'zod'
import type {
  Capabilities,
  LoginIdentity,
  LoginProvider,
  MarketplaceEntry,
  McpCatalogEntry,
  McpServerInfo,
  McpStatus,
  ModelInfo,
  ModelRef,
  ModelRoleInfo,
  PluginInfo,
  ProviderInfo,
  SettingDescriptor,
  SkillInfo,
} from './values'

export interface SessionFilesPort {
  exists(sessionFile: string): Promise<boolean>
  /**
   * 复制一条会话；给了 `keepTurns` 就只留屏幕上的前 `keepTurns` 轮（轮号就是时间线上 `turn.ordinal` 那个号，
   * 由引擎自己签发、自己认回）。不给 = 整条复制。`0` = 只留会话头不留任何一轮（「从第 1 轮重写」用它，
   * 对应 omp `/branch` 选中第一句时的空会话）。超出现有轮数、负数、非整数报 invalid_params，不静默夹到边界。
   */
  fork(
    sessionFile: string,
    keepTurns?: number,
    /** 新会话的名字（以用户定名写进 omp 会话头）；不给 = 沿用 omp 从原会话复制来的名字 */
    title?: string,
  ): Promise<{ sessionId: string; sessionFile: string }>
  /**
   * 给**没开着**的会话文件定名（omp SessionManager.open → setSessionName(name, 'user') → close）。开着的会话走
   * `EngineSession.rename`：同一个文件两个写者会互相覆盖会话头。空名报 invalid_params，文件不存在报 session_file_missing。
   */
  rename(sessionFile: string, title: string): Promise<void>
  delete(sessionFile: string): Promise<void>
  exportHtml(sessionFile: string, outFile: string): Promise<void>
  exportMarkdown(sessionFile: string): Promise<string>
}
export interface ModelsPort {
  providers(): Promise<z.infer<typeof ProviderInfo>[]>
  models(): Promise<z.infer<typeof ModelInfo>[]>
  setApiKey(provider: string, key: string): Promise<void> // key 永不回传
  /** 清掉这家名下的全部凭据（钥匙与订阅登录一起）：omp 的凭据表按服务商存，没有「只退登录」这一半 */
  clearApiKey(provider: string): Promise<void>
  /** 可订阅登录的服务商（omp 的 getOAuthProviders，含插件注册的） */
  loginProviders(): Promise<z.infer<typeof LoginProvider>[]>
  /**
   * 走一遍 omp 的订阅登录（AuthStorage.oauth.login）：要打开的网址、进度、要人填的东西都经 `io` 交给宿主，
   * 凭据由 omp 自己落库（agent.db），端口不经手 token。`io.signal` 中止 = 取消登录。
   */
  login(providerId: string, io: LoginIO): Promise<z.infer<typeof LoginIdentity> | null>
  setModelEnabled(ref: ModelRef, enabled: boolean): Promise<void>
  defaultModel(): Promise<ModelRef | null>
  setDefaultModel(ref: ModelRef): Promise<void>
  defaultThinking(): Promise<string | null>
  setDefaultThinking(level: string | null): Promise<void>
  /** omp 已知的全部模型角色（内置 + 自定义），每格带当前选择器与候选；产品不发明角色键（P5） */
  modelRoles(): Promise<z.infer<typeof ModelRoleInfo>[]>
  /** 写一格角色（omp 的 Settings.setModelRole，落 config.yml）；null = 删掉，回到 omp 的回退链；未知角色报 invalid_params */
  setModelRole(role: string, selector: string | null): Promise<void>
  upsertCustomProvider(def: CustomProviderDef): Promise<void>
  removeCustomProvider(id: string): Promise<void>
  readonly onDidChange: Event<void>
}
/** 订阅登录时 omp 要宿主做的几件事（omp OAuthLoginController 的宿主无关子集） */
export interface LoginIO {
  /** 打开这个网址让人去授权；`launchUrl` 是本机回环的短链（omp 推荐给人复制的那一条） */
  onAuth(info: { readonly url: string; readonly launchUrl: string | null; readonly instructions: string | null }): void
  onProgress(message: string): void
  /** 要人填一格（授权码、回调网址、组织名……）；`secret` = 输入要遮住 */
  onPrompt(prompt: {
    readonly message: string
    readonly placeholder: string | null
    readonly secret: boolean
    readonly allowEmpty: boolean
  }): Promise<string>
  readonly signal: AbortSignal
}
export interface CustomProviderDef {
  readonly id: string
  readonly name: string
  readonly api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  readonly baseUrl: string
  readonly models: readonly {
    id: string
    name: string
    contextWindow: number | null
    reasoning: boolean
    vision: boolean
  }[]
}
export interface SettingsPort {
  catalog(): Promise<z.infer<typeof SettingDescriptor>[]>
  /**
   * 设置页上分节的次序，是 **`group` 键**的序列（与 descriptor 的 `group` 字段同源 —— 界面按那个键归并，
   * 换成译名会让两条不同的键撞上同一个名字）。放在端口而不是让功能直接读 engine-omp：depcruise 禁止功能依赖 engine-omp。
   */
  readonly groupOrder: readonly string[]
  set(path: string, value: unknown): Promise<void>
  reset(path: string): Promise<void>
  capabilities(): Promise<z.infer<typeof Capabilities>>
  setCapability(name: keyof z.infer<typeof Capabilities>, enabled: boolean): Promise<void>
  /** 当前设置的 Python 解释器路径；没设置（自动探测）时为 null。 */
  getPythonInterpreter(): Promise<string | null>
  setPythonInterpreter(exePath: string | null): Promise<void>
  readonly onDidChange: Event<{ readonly paths: readonly string[] }>
}
export interface SkillsPort {
  list(cwd: string | null): Promise<z.infer<typeof SkillInfo>[]>
  setEnabled(id: string, enabled: boolean): Promise<void>
  installFromDirectory(dir: string): Promise<z.infer<typeof SkillInfo>>
  installFromZip(zipFile: string): Promise<z.infer<typeof SkillInfo>>
  /** 只清理 omp 设置里该技能的启用状态；技能目录由 extensions 经 Host 的 shell.trashItem 移到回收站。 */
  forget(id: string): Promise<void>
  read(id: string): Promise<{ markdown: string }>
}
export interface McpPort {
  list(): Promise<z.infer<typeof McpServerInfo>[]>
  upsert(server: z.infer<typeof McpServerInfo>): Promise<void>
  remove(name: string): Promise<void>
  status(): Promise<z.infer<typeof McpStatus>[]>
  /**
   * 在**在线目录**里搜服务器（omp 的 Smithery registry）。查不到就是空数组，不是错误；
   * 网络不通 / 目录方报错才抛（调用方据此显示「取不到目录」，而不是「没有结果」）。
   */
  catalog(query: string): Promise<z.infer<typeof McpCatalogEntry>[]>
  readonly onDidChangeStatus: Event<z.infer<typeof McpStatus>[]>
}
export interface PluginsPort {
  list(): Promise<z.infer<typeof PluginInfo>[]>
  marketplace(query: string | null): Promise<z.infer<typeof MarketplaceEntry>[]>
  install(id: string): Promise<z.infer<typeof PluginInfo>>
  uninstall(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
}
