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
  /**
   * 「确保不存在」：会话文件与它的产物一起删；**幂等** —— 文件本来就不在也报成功（omp 只在有了回复之后才落盘，
   * 没落过盘的会话、删到一半的会话都要删得掉）。只有真正删不掉（权限、占用）才抛。
   */
  delete(sessionFile: string): Promise<void>
  exportHtml(sessionFile: string, outFile: string): Promise<void>
  exportMarkdown(sessionFile: string): Promise<string>
}
export interface ModelsPort {
  providers(): Promise<z.infer<typeof ProviderInfo>[]>
  models(): Promise<z.infer<typeof ModelInfo>[]>
  setApiKey(provider: string, key: string): Promise<void> // key 永不回传
  /** 清掉这家名下存着的 API Key（账号登录的凭据不动；环境变量与 models.yml 里写死的钥匙不归这里删） */
  clearApiKey(provider: string): Promise<void>
  /**
   * 能用账号登录的服务商（omp 的 getOAuthProviders，含插件注册的）。只报真正走浏览器 / 设备码授权的那些：
   * omp 的登录名单里还有几十家「登录」其实只是收一把 API Key，它们走 setApiKey 那条路。
   */
  loginProviders(): Promise<z.infer<typeof LoginProvider>[]>
  /** 退出账号登录：删掉这家名下的 OAuth 凭据，API Key 不动；没登录时什么也不做 */
  logout(provider: string): Promise<void>
  /**
   * 走一遍 omp 的账号登录（AuthStorage.oauth.login）：要打开的网址、进度、要人填的东西都经 `io` 交给宿主，
   * 凭据由 omp 自己落库（agent.db），端口不经手 token。`io.signal` 中止 = 取消登录。
   */
  login(providerId: string, io: LoginIO): Promise<z.infer<typeof LoginIdentity> | null>
  setModelEnabled(ref: ModelRef, enabled: boolean): Promise<void>
  /** 新会话的默认模型（`defaultSelection().model` 的简写；选择器里带的 `:档位` 不会混进 id） */
  defaultModel(): Promise<ModelRef | null>
  /**
   * 「新对话用什么」的**唯一一份持久意图**：omp 的 `modelRoles.default`（选择器可带 `:档位` 后缀）。
   * `thinking` 只报选择器里**显式**写的那一档；没写就是 null，由模型自己的默认档、再由全局
   * `defaultThinkingLevel` 兜（omp 建会话时同一顺序）。
   */
  defaultSelection(): Promise<DefaultSelection>
  /**
   * 写这份意图。`thinking`：省略 = 保留原选择器里的档位后缀（只换模型）；null = 去掉后缀；
   * 字符串 = 写成 `provider/id:档位`（不是 omp 认的档位报 invalid_params）。
   * 只发 `onDidChangeDefaults`，不发 `onDidChange` —— 默认值变了不等于目录变了。
   */
  setDefaultModel(ref: ModelRef, thinking?: string | null): Promise<void>
  defaultThinking(): Promise<string | null>
  setDefaultThinking(level: string | null): Promise<void>
  /** omp 已知的全部模型角色（内置 + 自定义），每格带当前选择器与候选；产品不发明角色键（P5） */
  modelRoles(): Promise<z.infer<typeof ModelRoleInfo>[]>
  /** 写一格角色（omp 的 Settings.setModelRole，落 config.yml）；null = 删掉，回到 omp 的回退链；未知角色报 invalid_params */
  setModelRole(role: string, selector: string | null): Promise<void>
  upsertCustomProvider(def: CustomProviderDef): Promise<void>
  removeCustomProvider(id: string): Promise<void>
  /** 目录 / 凭据 / 白名单 / 非默认角色变了：会话池要换代（R-03） */
  readonly onDidChange: Event<void>
  /**
   * 只有「新会话默认值」变了（`modelRoles.default`、全局 `defaultThinkingLevel`）。与 onDidChange 分开发：
   * 活着的会话早已定好自己的模型与档位，默认值变更不该让会话池整池换代；入口页重读草稿表就够了。
   */
  readonly onDidChangeDefaults: Event<void>
}
/** 新会话默认的那一份意图（见 ModelsPort.defaultSelection） */
export interface DefaultSelection {
  readonly model: ModelRef | null
  readonly thinking: string | null
}
/** 账号登录时 omp 要宿主做的几件事（omp OAuthLoginController 的宿主无关子集） */
export interface LoginIO {
  /**
   * 打开这个网址让人去授权；`launchUrl` 是本机回环的短链（omp 推荐给人复制的那一条）。
   * `code` 是设备码流程要人在网页上输入的那串码（GitHub Copilot 这类），没有就是 null；`instructions` 是其余的说明。
   */
  onAuth(info: {
    readonly url: string
    readonly launchUrl: string | null
    readonly code: string | null
    readonly instructions: string | null
  }): void
  /** 给人看的进度（已是中文）；omp 报了一句端口不认识的话时不转发，免得把英文原文甩给人 */
  onProgress(message: string): void
  /**
   * 要人填一格（授权码、回调网址、组织名……）；`secret` = 输入要遮住。
   * `fallback` = 这一格是浏览器回调的备用通道（「没自动跳回就把授权码贴这里」），授权正常完成时不必填。
   */
  onPrompt(prompt: {
    readonly message: string
    readonly placeholder: string | null
    readonly secret: boolean
    readonly allowEmpty: boolean
    readonly fallback: boolean
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
