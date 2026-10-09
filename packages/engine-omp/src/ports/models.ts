import type { CustomProviderDef, ModelInfo, ModelRef, ModelsPort, ProviderInfo } from '@poietica/engine'
import { Emitter, type Logger } from '@poietica/foundation'
import type { z } from 'zod'
import { toEngineError } from '../errors'
import { readSetting, type SettingsScope, unsetGlobalSetting, writeGlobalSetting } from '../settings-access'
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
import { flushOf, readRecordEntry, writeRecordEntry } from './settings-writes'

/** 默认模型那一格：`modelRoles` 是 record 设置，`default` 是里面的键，值是整串 provider/id。 */
const MODEL_ROLES_PATH = 'modelRoles'
const DEFAULT_ROLE_KEY = 'default'
/** 全局那一档思考深度（session/settings.ts 的 cfgDefaultThinkingLevel）。 */
const DEFAULT_THINKING_PATH = 'defaultThinkingLevel'

/** ModelsPort 需要的东西：registry、凭据存储、root 设置、models.yml 的读写器。 */
export interface ModelsPortDeps {
  readonly registry: RegistryPort
  /** omp 的 AuthStorage.credentials 子 API */
  readonly credentials: {
    has(provider: string): boolean
    set(provider: string, value: { type: 'api_key'; key: string; source: string }): Promise<void>
    remove(provider: string): Promise<void>
  }
  readonly root: SettingsScope
  readonly customProviders: CustomProvidersFile
  readonly logger: Logger
  /** 写完参数目录后让 omp 重新读取（OmpEngine 传 registry.reload 或 registry.refreshIfStale） */
  readonly reload: () => Promise<void>
}

/**
 * 模型目录端口。读的是 omp 自己的注册表（内置目录 + 用户 models.yml），写的是它自己的两处真身：
 * 凭据进 agent.db（AuthStorage），默认模型与启用白名单进 config.yml（Settings）。
 * 本端口不持有第二份副本。
 */
export class OmpModelsPort implements ModelsPort {
  readonly #change = new Emitter<void>()
  readonly onDidChange = this.#change.event

  constructor(private readonly d: ModelsPortDeps) {}

  /** provider 列表：registry 认得的全部 provider；configured 看凭据（或免密钥端点）。 */
  async providers(): Promise<z.infer<typeof ProviderInfo>[]> {
    try {
      const ids = new Set<string>()
      for (const model of this.d.registry.all()) ids.add(model.provider)
      for (const model of this.d.registry.available()) ids.add(model.provider)
      const out: z.infer<typeof ProviderInfo>[] = []
      for (const id of [...ids].sort((left, right) => left.localeCompare(right))) {
        out.push({
          id,
          /* omp 的内置目录没有单独的 provider 显示名，官方 TUI 画的也是 id。 */
          name: id,
          configured: this.d.credentials.has(id),
          custom: await this.d.customProviders.defined(id),
          /* 产品不支持 OAuth 登录，所以只可能是这两档。 */
          authKind: 'api_key',
          /* omp 的目录里没有「文档地址」这一格，如实交 null，不编一个。 */
          docsUrl: null,
        })
      }
      return out
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 全部模型，带完整元数据；enabled 来自 omp 的 enabledModels 白名单。 */
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

  /* omp 知识 #12：API key 的写法固定是 credentials.set(provider, { type: 'api_key', key, source: 'login' })。 */
  async setApiKey(provider: string, key: string): Promise<void> {
    try {
      /*
       * 这一行下面到函数结束都不许出现 key：端口不记日志、不回传、不放进任何事件。
       * source: 'login' 是上游给「人自己填进来的钥匙」打的标记，不写它凭据来源分类会认错来路。
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
      await this.d.credentials.remove(provider)
      await this.#refreshCredentials()
      this.d.logger.info('api key cleared', { provider })
      this.#change.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /**
   * 停用/启用一条模型。写入面是全局层的 enabledModels（omp 的可用模型白名单；
   * 出处：config/model-settings.ts 的 cfgEnabledModels 与 model-resolver.ts 的 resolveAllowedModels）。
   */
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

  /** 默认模型：modelRoles.default，值是整串 provider/id。 */
  async defaultModel(): Promise<ModelRef | null> {
    try {
      const value = readRecordEntry(this.d.root, MODEL_ROLES_PATH, DEFAULT_ROLE_KEY)
      return typeof value === 'string' && value !== '' ? splitAlias(value) : null
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async setDefaultModel(ref: ModelRef): Promise<void> {
    try {
      writeRecordEntry(this.d.root, MODEL_ROLES_PATH, DEFAULT_ROLE_KEY, aliasOf(ref))
      await this.#flush()
      this.#change.fire()
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
      this.#change.fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 自定义 provider：整份读、整份写 models.yml，写完让 registry 重读。 */
  async upsertCustomProvider(def: CustomProviderDef): Promise<void> {
    try {
      /* models.yml 的三条规则在 CustomProvidersFile 里：整份读整份写、原子写、写完让 registry 重读。 */
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

  /** 凭据变了要让 registry 重算「这个 provider 能不能用」（omp 的目录是凭据作用域的）。 */
  async #refreshCredentials(): Promise<void> {
    await this.d.registry.hydrateCredentialScopedModelCaches()
    this.d.registry.refreshInBackground()
    /*
     * 写完凭据让 omp 自己重扫一遍：只刷内存快照的话，agent.db 里那把钥匙要等下次启动才被认到。
     * 刷新失败不改「钥匙已经写进去了」这个事实：如实记 warn 就好。
     */
    await this.d.reload().catch((error: unknown) => {
      this.d.logger.warn('model registry reload failed', { error: String(error) })
    })
  }

  async #flush(): Promise<void> {
    await flushOf(this.d.root)
  }

  /** AgentEngine.dispose 时一并释放监听器。 */
  dispose(): void {
    this.#change.dispose()
  }
}

/** provider/id → ModelRef；没有斜杠就原样当 provider 与 id（坏值如实交出去，不猜）。 */
function splitAlias(alias: string): ModelRef {
  const cut = alias.indexOf('/')
  if (cut <= 0 || cut === alias.length - 1) return { provider: alias, id: alias }
  return { provider: alias.slice(0, cut), id: alias.slice(cut + 1) }
}

/** 让 biome 知道 OmpModelLike 在这里被用作形状约束（RegistryPort 的成员）。 */
export type { OmpModelLike }
