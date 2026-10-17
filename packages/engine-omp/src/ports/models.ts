import { extractExplicitThinkingSelector, resolveModelRoleValue } from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import type {
  CustomProviderDef,
  DefaultSelection,
  LoginIdentity,
  LoginIO,
  LoginProvider,
  ModelInfo,
  ModelRef,
  ModelRoleInfo,
  ModelsPort,
  ProviderInfo,
} from '@poietica/engine'
import { AppError, Emitter, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { z } from 'zod'
import { toEngineError } from '../errors'
import { readSetting, type SettingsScope, unsetGlobalSetting, writeGlobalSetting } from '../settings-access'
import { THINKING_ORDER } from './draft-controls'
import { loginAuthText, loginProgressText, loginPromptText } from './login-text'
import {
  aliasOf,
  ENABLED_MODELS_PATH,
  enabledMatcher,
  nextEnabledPatterns,
  type OmpModelLike,
  type RegistryPort,
  stringArrayOf,
} from './model-helpers'
import type { CustomProvidersFile } from './models-file'
import { flushOf, modelRoleOf, setModelRoleOf, settingsInstanceOf } from './settings-writes'

/** 默认模型那一格：`modelRoles.default`，值是整串 provider/id */
const DEFAULT_ROLE_KEY = 'default'
/** 旧版 Poietica 自造的 `modelRoles.title`（omp 不认）：启动时迁到 omp 的 tiny 角色后删掉，见 migrateLegacyTitleRole */
const LEGACY_TITLE_ROLE_KEY = 'title'
/** 全局那一档思考深度（session/settings.ts 的 cfgDefaultThinkingLevel） */
const DEFAULT_THINKING_PATH = 'defaultThinkingLevel'

/** ModelsPort 需要的东西：registry、凭据存储、root 设置、models.yml 的读写器 */
export interface ModelsPortDeps {
  readonly registry: RegistryPort
  /** omp 的 AuthStorage.credentials 子 API */
  readonly credentials: {
    has(provider: string): boolean
    set(provider: string, value: { type: 'api_key'; key: string; source: string }): Promise<void>
    /** 这家名下存着的每一行凭据（API Key 与 OAuth 各占一行，按行删才能只删其中一种） */
    list(provider: string): readonly { readonly id: number; readonly credential: { readonly type: string } }[]
    removeById(provider: string, credentialId: number): Promise<boolean>
  }
  /** omp 的账号登录（AuthStorage.oauth.login + getOAuthProviders + credentials 的 OAuth 那几行）；凭据由 omp 自己落库 */
  readonly oauth: OmpOAuth
  /** omp 的模型角色目录（config/model-roles）；角色清单、名字、候选全由 omp 定，端口不自列 */
  readonly roles: OmpRoles
  readonly root: SettingsScope
  readonly customProviders: CustomProvidersFile
  readonly logger: Logger
  /** 写完参数目录后让 omp 重新读取（组合根传 registry.refreshIfStale；omp 知识 #18 没有 reload） */
  readonly reload: () => Promise<void>
}

/** omp 的角色目录（真身：config/model-roles 的 getKnownRoleIds / getRoleInfo / roleCandidatePool） */
export interface OmpRoles {
  known(): readonly string[]
  info(role: string): { readonly name: string; readonly description: string | null; readonly section: 'chat' | 'kind' }
  candidates(role: string): readonly OmpModelLike[]
}

/** omp 账号登录那几件事的最小形状（真身：pi-ai 的 getOAuthProviders / getProviderDefinition 与 AuthStorage.oauth / credentials） */
export interface OmpOAuth {
  /**
   * `kind`：`account` = 账号授权（浏览器回调、粘贴授权码或设备码，拿回可刷新的令牌）；
   * `browser-key` = 浏览器里授权，换回一把 API Key；`manual-key` = 这条「登录」只是让人贴一把 API Key（不报给宿主）
   */
  providers(): readonly {
    id: string
    name: string
    available: boolean
    storeCredentialsAs?: string
    kind: 'account' | 'browser-key' | 'manual-key'
  }[]
  /** 这家名下有没有账号登录留下的凭据（credentials.hasOAuth）；API Key、环境变量不算 */
  authenticated(provider: string): boolean
  /** 那份 OAuth 凭据记的账号：邮箱，没有就组织名 */
  account(provider: string): string | null
  /** 删掉这家名下的 OAuth 凭据，API Key 那几行不动 */
  logout(provider: string): Promise<void>
  login(
    providerId: string,
    ctrl: {
      onAuth(info: { url: string; launchUrl?: string; instructions?: string }): void
      onProgress(message: string): void
      onPrompt(prompt: {
        message: string
        placeholder?: string
        secret?: boolean
        allowEmpty?: boolean
      }): Promise<string>
      signal: AbortSignal
    },
  ): Promise<{ type: 'oauth' | 'api_key'; email?: string; orgName?: string } | undefined>
}

/** 读 omp 自己的注册表（内置目录 + 用户 models.yml），写它自己的两处真身：凭据进 agent.db、默认模型与白名单进 config.yml */
export class OmpModelsPort implements ModelsPort {
  readonly #change = new Emitter<void>()
  readonly onDidChange = this.#change.event
  /** 只有新会话默认值变了（见 ModelsPort.onDidChangeDefaults）：不让会话池为它换代 */
  readonly #defaults = new Emitter<void>()
  readonly onDidChangeDefaults = this.#defaults.event

  constructor(private readonly d: ModelsPortDeps) {}

  /** provider 列表：`configured` 用 **omp 自己的鉴权判据**（`hasConfiguredAuth`，逐条模型问），凭据表只是它认的四个来源之一 */
  async providers(): Promise<z.infer<typeof ProviderInfo>[]> {
    try {
      /** 全部模型按 provider 归并：判鉴权要拿得到「这家的一条模型」，目录里没有的 provider 无从判起 */
      const models = new Map<string, OmpModelLike>()
      for (const model of this.d.registry.all()) models.set(model.provider, model)
      for (const model of this.d.registry.available()) {
        if (!models.has(model.provider)) models.set(model.provider, model)
      }
      const out: z.infer<typeof ProviderInfo>[] = []
      for (const [id, model] of [...models].sort(([left], [right]) => left.localeCompare(right))) {
        out.push({
          id,
          /** omp 的内置目录没有单独的 provider 显示名，官方 TUI 画的也是 id */
          name: id,
          /*
           * omp 知识 #18：`configured` 必须与 omp 自己「这家能不能用」的判据同源，否则界面会把 models.yml
           * 里写死 apiKey、或声明 `auth: none` 的免密钥服务商误报成没配 —— 真机上入口页因此挂着「还没有配置
           * 任何模型服务商」，而模型选择器一条不少地列着它们。hasConfiguredAuth 认四类来源，只查 credentials.has 就只认了凭据表这一类。
           */
          configured: this.d.registry.hasConfiguredAuth(model),
          custom: await this.d.customProviders.defined(id),
          /** 钥匙那条路；账号登录另走 loginProviders / login（一家可以两条都有） */
          authKind: 'api_key',
          /** omp 的目录里没有「文档地址」这一格，如实交 null，不编一个 */
          docsUrl: null,
        })
      }
      return out
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 全部模型，带完整元数据；enabled 来自 omp 的 enabledModels 白名单 */
  async models(): Promise<z.infer<typeof ModelInfo>[]> {
    try {
      const matcher = enabledMatcher(stringArrayOf(readSetting(this.d.root, ENABLED_MODELS_PATH)))
      return this.d.registry.all().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name ?? model.id,
        enabled: matcher({ provider: model.provider, id: model.id }),
        contextWindow: model.contextWindow ?? null,
        reasoning: model.reasoning === true,
        vision: model.input?.includes('image') === true,
      }))
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** omp 知识 #12：API key 的写法固定是 credentials.set(provider, { type: 'api_key', key, source: 'login' }) */
  async setApiKey(provider: string, key: string): Promise<void> {
    try {
      /*
       * 这一行下面到函数结束都不许出现 key：端口不记日志、不回传、不放进任何事件。source: 'login' 是上游给
       * 「人自己填进来的钥匙」打的标记，不写它凭据来源分类会认错来路。
       */
      await this.d.credentials.set(provider, { type: 'api_key', key, source: 'login' })
      await this.#refreshCredentials()
      this.d.logger.info('api key stored', { provider })
      this.#change.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async clearApiKey(provider: string): Promise<void> {
    try {
      /* 只删 API Key 那几行：同一家名下的账号登录是另一件事，走 logout */
      for (const row of this.d.credentials.list(provider)) {
        if (row.credential.type === 'api_key') await this.d.credentials.removeById(provider, row.id)
      }
      await this.#refreshCredentials()
      this.d.logger.info('api key cleared', { provider })
      this.#change.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async loginProviders(): Promise<z.infer<typeof LoginProvider>[]> {
    try {
      return this.d.oauth
        .providers()
        .filter((entry) => entry.kind !== 'manual-key')
        .map((entry) => {
          const provider = entry.storeCredentialsAs ?? entry.id
          const issuesApiKey = entry.kind === 'browser-key'
          const authenticated = !issuesApiKey && this.d.oauth.authenticated(provider)
          return {
            id: entry.id,
            name: entry.name,
            provider,
            available: entry.available,
            authenticated,
            account: authenticated ? this.d.oauth.account(provider) : null,
            issuesApiKey,
          }
        })
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async logout(provider: string): Promise<void> {
    try {
      if (!this.d.oauth.authenticated(provider)) return
      await this.d.oauth.logout(provider)
      await this.d.registry.refreshProvider(provider)
      await this.#refreshCredentials()
      this.d.logger.info('account logout', { provider })
      this.#change.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /**
   * 照 omp rpc-mode 的 `login` 分支做：交 omp 的 oauth.login，成功后只刷这一家（refreshProvider online），
   * 新凭据才会重跑这家的模型发现。与 rpc-mode 不同的只有一处：图形宿主能遮住输入，所以 `secret` 的那一格不拒绝。
   */
  async login(providerId: string, io: LoginIO): Promise<z.infer<typeof LoginIdentity> | null> {
    try {
      const known = this.d.oauth.providers().find((entry) => entry.id === providerId)
      if (known === undefined) throw new AppError(SystemErrorCode.invalidParams, `不支持用账号登录：${providerId}`)
      /* omp 推来的话一律先过 login-text：认得的换成中文，进度不认得就不转发 */
      const identity = await this.d.oauth.login(providerId, {
        onAuth: (info) =>
          io.onAuth({ url: info.url, launchUrl: info.launchUrl ?? null, ...loginAuthText(info.instructions ?? null) }),
        onProgress: (message) => {
          const text = loginProgressText(message)
          if (text !== null) io.onProgress(text)
        },
        onPrompt: (prompt) =>
          io.onPrompt({
            ...loginPromptText(prompt.message, prompt.placeholder ?? null),
            secret: prompt.secret === true,
            allowEmpty: prompt.allowEmpty === true,
          }),
        signal: io.signal,
      })
      await this.d.registry.refreshProvider(known.storeCredentialsAs ?? known.id)
      await this.#refreshCredentials()
      this.d.logger.info('account login stored', { provider: providerId })
      this.#change.fire()
      if (identity === undefined) return null
      return { kind: identity.type, email: identity.email ?? null, orgName: identity.orgName ?? null }
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 停用 / 启用一条模型。写入面是全局层的 enabledModels（omp 的可用模型白名单） */
  async setModelEnabled(ref: ModelRef, enabled: boolean): Promise<void> {
    try {
      const patterns = stringArrayOf(readSetting(this.d.root, ENABLED_MODELS_PATH))
      const available = this.d.registry.available().map(aliasOf)
      const next = nextEnabledPatterns(patterns, available, ref, enabled)
      if (next !== patterns) {
        writeGlobalSetting(this.d.root, ENABLED_MODELS_PATH, next)
        await this.#flush()
      }
      this.#change.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async defaultModel(): Promise<ModelRef | null> {
    return (await this.defaultSelection()).model
  }

  /**
   * 解析交给 omp 自己（resolveModelRoleValue / extractExplicitThinkingSelector，建会话时同一对函数）：
   * 旧实现按第一个斜杠硬切，`anthropic/claude-opus-4-5:max` 会切出 id=`claude-opus-4-5:max`，
   * 草稿表在目录里找不到它，梯子为空、档位被丢，入口页显示的和新会话实际用的就分了岔。
   */
  async defaultSelection(): Promise<DefaultSelection> {
    try {
      const read = this.#readDefault()
      return { model: read.model, thinking: levelOrNull(read.explicit) }
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 只换模型时保留原后缀，与 omp 自己的 formatRoleModelValue 同一规矩（用户在 omp 里写的档位不被我们抹掉） */
  async setDefaultModel(ref: ModelRef, thinking?: string | null): Promise<void> {
    try {
      if (typeof thinking === 'string' && !THINKING_ORDER.includes(thinking)) {
        throw new AppError(SystemErrorCode.invalidParams, `omp 不认这个思考档位：${thinking}`)
      }
      /* 保留的是**原样**的后缀（含 `off` 这类不上梯子的写法）；`inherit` 与 omp formatModelSelectorValue 一样不落 */
      const kept = thinking === undefined ? this.#readDefault().explicit : (thinking ?? undefined)
      const suffix = kept === undefined || kept === 'inherit' ? '' : `:${kept}`
      setModelRoleOf(this.d.root, DEFAULT_ROLE_KEY, `${aliasOf(ref)}${suffix}`)
      await this.#flush()
      this.#defaults.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** omp 已知的全部角色（内置在前，再是 cycleOrder / modelRoles / modelTags 里出现的自定义角色），选择器原样交回 */
  async modelRoles(): Promise<z.infer<typeof ModelRoleInfo>[]> {
    try {
      return this.d.roles.known().map((role) => {
        const info = this.d.roles.info(role)
        const selector = modelRoleOf(this.d.root, role)
        return {
          role,
          name: info.name,
          description: info.description,
          section: info.section,
          selector: selector === undefined || selector === '' ? null : selector,
          candidates: this.d.roles
            .candidates(role)
            .map((model) => ({ selector: aliasOf(model), label: model.name ?? model.id })),
        }
      })
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 只写 omp 认得的角色（P5：不发明设置键）；选择器原样落 config.yml，omp 解析时自己认 `@role` / `:level` */
  async setModelRole(role: string, selector: string | null): Promise<void> {
    try {
      if (!this.d.roles.known().includes(role)) {
        throw new AppError(SystemErrorCode.invalidParams, `omp 不认这个模型角色：${role}`)
      }
      setModelRoleOf(this.d.root, role, selector === null || selector === '' ? undefined : selector)
      await this.#flush()
      /* default 那一格就是新会话的默认意图：只是默认值变了，其余角色（tiny / smol …）活着的会话也在用 */
      if (role === DEFAULT_ROLE_KEY) this.#defaults.fire()
      else this.#change.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async defaultThinking(): Promise<string | null> {
    try {
      const value = readSetting(this.d.root, DEFAULT_THINKING_PATH)
      return typeof value === 'string' && value !== '' ? value : null
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async setDefaultThinking(level: string | null): Promise<void> {
    try {
      if (level === null) unsetGlobalSetting(this.d.root, DEFAULT_THINKING_PATH)
      else writeGlobalSetting(this.d.root, DEFAULT_THINKING_PATH, level)
      await this.#flush()
      /* 全局默认档只在建会话时读一次：活着的会话不受它影响，不必换代 */
      this.#defaults.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 自定义 provider：整份读、整份写 models.yml，写完让 registry 重读 */
  async upsertCustomProvider(def: CustomProviderDef): Promise<void> {
    try {
      /** models.yml 的三条规则：整份读整份写、原子写、写完让 registry 重读 */
      await this.d.customProviders.upsert(def)
      this.#change.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async removeCustomProvider(id: string): Promise<void> {
    try {
      await this.d.customProviders.remove(id)
      this.#change.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 凭据变了要让 registry 重算「这个 provider 能不能用」（omp 的目录是凭据作用域的） */
  async #refreshCredentials(): Promise<void> {
    await this.d.registry.hydrateCredentialScopedModelCaches()
    this.d.registry.refreshInBackground()
    /* 写完凭据让 omp 自己重扫：只刷内存快照的话，agent.db 里那把钥匙要等下次启动才被认到 */
    await this.d.reload().catch((error: unknown) => {
      this.d.logger.warn('model registry reload failed', { error: String(error) })
    })
  }

  /** `modelRoles.default` → 模型 + 选择器里显式写的档位（原样，未过滤） */
  #readDefault(): { readonly model: ModelRef | null; readonly explicit: string | undefined } {
    const selector = modelRoleOf(this.d.root, DEFAULT_ROLE_KEY)?.trim()
    if (selector === undefined || selector === '') return { model: null, explicit: undefined }
    const settings = settingsInstanceOf(this.d.root)
    const all = this.d.registry.all()
    const explicit = extractExplicitThinkingSelector(selector, settings, {
      isLiteralModelId: (provider, id) =>
        all.some((model) => model.id === id && (provider === undefined || model.provider === provider)),
    })
    const resolved = resolveModelRoleValue(selector, all as never, { settings })
    return {
      model: resolved.model === undefined ? literalRefOf(selector, explicit) : refOfModel(resolved.model),
      explicit,
    }
  }

  async #flush(): Promise<void> {
    await flushOf(this.d.root)
  }

  /** AgentEngine.dispose 时一并释放监听器 */
  dispose(): void {
    this.#change.dispose()
    this.#defaults.dispose()
  }
}

/** provider/id → ModelRef；没有斜杠就原样当 provider 与 id（坏值如实交出去，不猜） */
function splitAlias(alias: string): ModelRef {
  const cut = alias.indexOf('/')
  if (cut <= 0 || cut === alias.length - 1) return { provider: alias, id: alias }
  return { provider: alias.slice(0, cut), id: alias.slice(cut + 1) }
}

/** omp 解出来的那条模型 → ModelRef */
function refOfModel(model: { readonly provider: string; readonly id: string }): ModelRef {
  return { provider: model.provider, id: model.id }
}

/**
 * 目录里解不出来（下架的 id、provider 暂时没凭据）时按字面报：先去掉 omp 认出的档位后缀再切。
 * 如实报出那条坏值，不换成别的 —— 换了等于替用户做决定（草稿表会照原样显示它）。
 */
function literalRefOf(selector: string, explicit: string | undefined): ModelRef {
  const suffix = explicit === undefined ? '' : `:${explicit}`
  const bare = suffix !== '' && selector.endsWith(suffix) ? selector.slice(0, -suffix.length) : selector
  return splitAlias(bare)
}

/** 只把真正的「一档」交出去：`inherit` / `auto` / `off` 不是梯子上的档，交 null 让模型默认档与全局默认去兜 */
function levelOrNull(level: string | undefined): string | null {
  return level !== undefined && THINKING_ORDER.includes(level) ? level : null
}

/**
 * 旧版的「标题模型」写在 omp 不认的 `modelRoles.title`，靠每个会话把它覆盖进 tiny 才生效。迁移：tiny 没配就把它挪进
 * tiny（omp 的标题模型角色），并把 `title.generator` 切到 tiny —— 用户当初要的是「标题由这个模型写」，而 omp 默认的
 * fork 生成器用会话自己的模型、只在 fork 失败时才轮到 tiny。tiny 已配则以用户在 omp 里的选择为准，旧键直接删。
 */
export async function migrateLegacyTitleRole(scope: SettingsScope): Promise<boolean> {
  const legacy = modelRoleOf(scope, LEGACY_TITLE_ROLE_KEY)
  if (legacy === undefined) return false
  const tiny = modelRoleOf(scope, 'tiny')
  if (legacy !== '' && (tiny === undefined || tiny === '')) {
    setModelRoleOf(scope, 'tiny', legacy)
    writeGlobalSetting(scope, 'title.generator', 'tiny')
  }
  setModelRoleOf(scope, LEGACY_TITLE_ROLE_KEY, undefined)
  await flushOf(scope)
  return true
}

/** 让 biome 知道 OmpModelLike 在这里被用作形状约束（RegistryPort 的成员） */
export type { OmpModelLike }
