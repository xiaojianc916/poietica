/*
 * 模型目录：界面那一页要的那四格。
 *
 * 读的是 agent 自己的模型注册表（内置目录 + 用户 models.yml 里的自定义 provider），
 * 写的是 agent 自己的两处真身：凭据进 agent.db（AuthStorage 的持久层），默认模型
 * 进 config.yml（Settings 的持久层）。本层不持有第二份副本。
 *
 * 四格各自的判据，与官方 TUI 的选择器同一套（pi-tui 的 overlays/model-hub.ts）：
 *
 * - providers：**已经能用的**（有凭据，或本地无钥匙端点）。这一栏是「我配了哪些」。
 * - catalog：**还没配的**（内置目录里有、但没有凭据）。这一栏是「我可以加哪些」，
 *   界面拿它填「从目录添加」。两栏互斥，同一个 provider 不会两边都出现。
 * - models：providers 那一栏各自的模型，带完整的推理元数据。
 * - defaultModel：当前默认模型。
 *
 * 增删 provider 还没接（要动 models.yml，是另一件活），所以那几条操作如实报不支持，
 * 而不是回一份没变的快照假装改成功了。
 */

import type { AuthStorage, ModelRegistry, Settings } from '@oh-my-pi/pi-coding-agent'

import type { ModelCatalogOperation } from './protocol.ts'

/** 界面那一页读的四格，与 crates/agent-client 的 ModelCatalogSnapshot 对应。 */
export interface CatalogSnapshot {
  readonly providers: readonly CatalogProvider[]
  readonly models: readonly CatalogModelEntry[]
  readonly catalog: readonly CatalogEntry[]
  readonly defaultModel: string | null
}

/** 已经配好的一个 provider。 */
interface CatalogProvider {
  readonly id: string
  readonly type: string
  readonly baseUrl: string | null
  readonly defaultModel: string | null
  readonly hasApiKey: boolean
  readonly status: string
  readonly models: readonly string[] | null
}

/** 一条已配置 provider 的模型。 */
interface CatalogModelEntry {
  readonly provider: string
  readonly model: string
  readonly displayName: string | null
  readonly maxContextSize: number
  readonly capabilities: readonly string[] | null
  readonly maxOutputSize: number | null
  readonly supportEfforts: readonly string[] | null
  readonly adaptiveThinking: boolean | null
  readonly defaultEffort: string | null
}

/** 目录里一个还没配的 provider（「从目录添加」那一栏）。 */
interface CatalogEntry {
  readonly id: string
  readonly name: string
  readonly wireType: string | null
  readonly guessed: boolean
  readonly needsBaseUrl: boolean
  readonly rejected: boolean
  readonly rejectReason: string | null
  readonly envKey: string | null
  readonly models: readonly CatalogModel[]
}

interface CatalogModel {
  readonly id: string
  readonly name: string | null
  readonly maxContextSize: number
  readonly capabilities: readonly string[] | null
  readonly reasoning: boolean
}

/** 一条模型在界面上的名字：provider/id。与 selectors 用的是同一个拼法。 */
export function aliasOf(model: { readonly provider: string; readonly id: string }): string {
  return `${model.provider}/${model.id}`
}

/** 注册表里一条模型的形状；只取本层用得着的几格。 */
interface RegistryModel {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly api: string
  readonly baseUrl: string
  readonly reasoning: boolean
  readonly input: readonly string[]
  readonly contextWindow: number | null
  readonly maxTokens: number | null
  readonly thinking?:
    | {
        readonly efforts?: readonly string[]
        readonly defaultLevel?: string
        readonly mode?: string
        readonly requiresEffort?: boolean
      }
    | undefined
}

/*
 * 一条模型的推理元数据。
 *
 * 全部来自 agent 自己的注册表（pi-catalog 的 ThinkingConfig 经 buildModel 烘进每一
 * 行）：`efforts` 是它支持的档位梯子，`defaultLevel` 是选中它时的默认档，`mode`
 * 是编码方式。界面那几格就填这些 —— 不填 null 假装「没有这回事」。
 */
function modelEntryOf(model: RegistryModel): CatalogModelEntry {
  const efforts = model.thinking?.efforts ?? null

  return {
    provider: model.provider,
    model: model.id,
    displayName: model.name ?? null,
    maxContextSize: model.contextWindow ?? 0,
    capabilities: capabilitiesOf(model),
    maxOutputSize: model.maxTokens ?? null,
    supportEfforts: efforts,
    /* 自适应思考 = 上游把 effort 映到厂商的自适应参数（Anthropic adaptive 一族）。 */
    adaptiveThinking: model.thinking?.mode === 'anthropic-adaptive' ? true : null,
    defaultEffort: model.thinking?.defaultLevel ?? null,
  }
}

/*
 * 一条模型的能力位。
 *
 * 界面按 `thinking` / `always_thinking` 两格判「这一条支不支持思考、能不能关」，
 * 其余位原样透传。`always_thinking` 是上游 `thinking.requiresEffort` 的意思：
 * 那种端点拒掉「不思考」的请求（types.ts 的 ThinkingConfig.requiresEffort）。
 */
function capabilitiesOf(model: RegistryModel): readonly string[] {
  const capabilities: string[] = []

  if (model.reasoning) {
    capabilities.push(model.thinking?.requiresEffort === true ? 'always_thinking' : 'thinking')
  }
  if (model.input.includes('image')) {
    capabilities.push('image')
  }

  return capabilities
}

export function snapshotOf(
  registry: ModelRegistry,
  authStorage: AuthStorage,
  settings: Settings,
  defaultModel: string | null,
): CatalogSnapshot {
  const every = registry.getAll('all') as unknown as readonly RegistryModel[]

  /*
   * 哪些 provider 已经有凭据、且没被停用。
   *
   * 判据照抄官方注册表那一句（config/model-registry.ts 的
   * `#createProviderAvailabilityCheck`）：`keys.source` 有来源、或它是免密钥的
   * （`keys.keyless`），且不在停用表里。旧版的 `hasAuth` 已随 18.3.0 拆进
   * `credentials` / `keys` 两组子 API，原来那一个名字没有了。
   *
   * 停用的 provider 不进 providers，也不进 catalog —— 它此刻两栏都不该出现，人想
   * 再用就去「添加供应商」里重新配一次。
   */
  const disabled = new Set(settings.get('disabledProviders') ?? [])
  const keyed = new Set<string>()
  for (const model of every) {
    const available =
      !disabled.has(model.provider) &&
      (authStorage.keys.source(model.provider) !== undefined ||
        authStorage.keys.keyless(model.provider))

    if (available) {
      keyed.add(model.provider)
    }
  }

  const providers: CatalogProvider[] = []
  const models: CatalogModelEntry[] = []
  const catalog: CatalogEntry[] = []

  for (const provider of new Set(every.map((model) => model.provider))) {
    if (disabled.has(provider)) {
      continue
    }

    const rows = every.filter((model) => model.provider === provider)

    if (keyed.has(provider)) {
      providers.push({
        id: provider,
        type: rows[0]?.api ?? provider,
        baseUrl: rows[0]?.baseUrl ?? null,
        defaultModel: null,
        hasApiKey: true,
        status: 'ready',
        models: rows.map((model) => model.id),
      })
      models.push(...rows.map(modelEntryOf))
      continue
    }

    /*
     * 没凭据的进目录那一栏 —— 界面拿它填「从目录添加」。
     *
     * 名字先用 provider id：上游的内置目录没有单独的 provider 显示名，官方 TUI 的
     * 侧栏写的也是 id（pi-tui 的 overlays/model-hub.ts，`label: providerId`）。
     *
     * `envKey` 取自上游自己的凭据来源分类（`keys.source` 的 `envVar`）：有些
     * provider 靠环境变量就能用，界面把那个变量名写出来，人才知道该配什么。
     */
    const origin = authStorage.keys.source(provider)

    catalog.push({
      id: provider,
      name: provider,
      wireType: rows[0]?.api ?? null,
      guessed: false,
      needsBaseUrl: false,
      rejected: false,
      rejectReason: null,
      envKey: origin?.kind === 'env' ? (origin.envVar ?? null) : null,
      models: rows.map((model) => ({
        id: model.id,
        name: model.name ?? null,
        maxContextSize: model.contextWindow ?? 0,
        capabilities: capabilitiesOf(model),
        reasoning: model.reasoning,
      })),
    })
  }

  return {
    providers: providers.sort((left, right) => left.id.localeCompare(right.id)),
    models,
    catalog: catalog.sort((left, right) => left.id.localeCompare(right.id)),
    defaultModel,
  }
}

/**
 * 一次目录操作。
 *
 * 四处写都由调用方注入，因为它们是四个不同的持久层：凭据进 agent.db
 * （AuthStorage）、默认模型进 config.yml（Settings）、provider 定义进 models.yml
 * （`defineProvider` / `overrideProvider`）、provider 启停进 config.yml 的
 * `disabledProviders`（`enableProvider`）。这一层只管形状与顺序。
 */
export interface CatalogWrites {
  readonly defaultModel: (modelId: string) => Promise<void>
  readonly apiKey: (provider: string, apiKey: string) => Promise<void>
  readonly dropProvider: (provider: string) => Promise<void>
  readonly defineProvider: (provider: ProviderDefinition, previousId?: string) => Promise<void>
  readonly overrideProvider: (
    provider: string,
    baseUrl: string,
    api: string | null,
  ) => Promise<void>
  readonly enableProvider: (provider: string) => Promise<void>
}

export async function executeCatalog(
  operation: ModelCatalogOperation,
  registry: ModelRegistry,
  authStorage: AuthStorage,
  settings: Settings,
  currentDefault: string | null,
  write: CatalogWrites,
): Promise<CatalogSnapshot> {
  switch (operation.kind) {
    case 'snapshot':
      return snapshotOf(registry, authStorage, settings, currentDefault)

    case 'refreshProviders':
      await registry.refresh()
      return snapshotOf(registry, authStorage, settings, currentDefault)

    case 'setDefault':
      await write.defaultModel(operation.modelId)
      return snapshotOf(registry, authStorage, settings, operation.modelId)

    /*
     * 配一把钥匙。
     *
     * 走上游自己的写入面 `AuthStorage.set`（它内部按 provider 替换整行、刷新内存
     * 快照、重置该 provider 的凭据轮转），落盘在受控 home 的 agent.db —— 不是内存
     * 里的临时覆盖，人配一次就该留到下次开软件。`source: 'login'` 是上游给
     * 「人自己填进来的钥匙」打的标记（auth-storage.ts 的 login 同款），不写它，
     * 上游的凭据来源分类会把我们的钥匙认成另一种来路。
     *
     * 写完要重问目录：有了钥匙的 provider 会从 catalog 那一栏挪进 providers。
     */
    case 'setApiKey':
      await write.apiKey(operation.provider, operation.apiKey)
      await registry.refresh()
      return snapshotOf(registry, authStorage, settings, currentDefault)

    /*
     * 删掉一个 provider。
     *
     * 三件事：凭据从 agent.db 删（`AuthStorage.remove`）、定义从 models.yml 删
     * （用户自建的那些才有）、provider 停用（`disableProvider` 写
     * `disabledProviders`）。
     *
     * 内置 provider 的定义删不掉：那是 omp 编在包里的目录，不是我们的文件。所以
     * 它停用之后回到「从目录添加」那一栏，人想再用就再配一次 —— 界面看到的就是
     * 「没了」，这一点两边一致。
     */
    case 'delete':
      await write.dropProvider(operation.providerId)
      await registry.refresh()
      return snapshotOf(registry, authStorage, settings, currentDefault)

    case 'create':
    case 'replace':
    case 'importCatalog':
      await applyProvider(operation, registry, write)
      await registry.refresh()
      return snapshotOf(registry, authStorage, settings, currentDefault)

    /*
     * 认不得的操作如实拒绝：静默回一份没变的快照，界面会以为改成功了。
     *
     * 这一支在类型上已经穷尽（上面每个判别式都接了），留着是因为判别式是**线上来的**
     * —— 类型只是我们的声明，不是对端的保证。断言回原形状只为把 kind 打进消息。
     */
    default:
      throw new Error(
        `the model catalog does not implement ${(operation as { kind: string }).kind} yet`,
      )
  }
}

/**
 * 三种「让一个 provider 出现」的操作：建、整份换、从目录添加。
 *
 * 三者都要写同样的最后一步 —— 把它从停用表里**拿掉**。`disabledProviders` 在凭据
 * 之前判（官方 providers.md 的「How omp decides a provider is available」），停用的
 * provider 就算有钥匙也一条模型都不出。漏了这一步，「删除」写进去的停用标记就永远
 * 盖着，人再配一次也回不来 —— 界面看上去正是「写了配置完全没反应」。
 */
async function applyProvider(
  operation: Extract<ModelCatalogOperation, { kind: 'create' | 'replace' | 'importCatalog' }>,
  registry: ModelRegistry,
  write: CatalogWrites,
): Promise<void> {
  if (operation.kind === 'create') {
    await write.defineProvider(definitionOf(operation.provider, operation.provider.id))
    await writeKey(operation.provider.id, operation.provider.apiKey, write)
    await write.enableProvider(operation.provider.id)
    return
  }

  if (operation.kind === 'replace') {
    const id = operation.provider.newId ?? operation.providerId

    await write.defineProvider(definitionOf(operation.provider, id), operation.providerId)
    await writeKey(id, operation.provider.apiKey, write)
    await write.enableProvider(id)
    /* 改名时旧名要清掉：密钥是按 provider 名存的，留着旧名就是一行孤儿凭据。 */
    if (id !== operation.providerId) {
      await write.dropProvider(operation.providerId)
    }
    return
  }

  await importFromCatalog(operation, registry, write)
}

/**
 * 从内置目录添加一个 provider。
 *
 * 目录那一栏列的是「omp 认识、但还没有凭据」的 provider，它们的 baseUrl / api /
 * 模型清单**已经在 omp 编在包里的目录里**。所以原样添加（id 不变）时不用往
 * models.yml 写任何东西：钥匙进 agent.db、把它从停用表里拿掉，它的模型就出来了 ——
 * 上游改了目录，界面跟着改，因为我们没抄第二份。
 *
 * 只有两种情形要写文件：
 *
 * - 改了 `id`：omp 按 id 认 provider，新 id 在目录里不存在，得把这一行的定义整份
 *   搬过去（否则新 id 一条模型都没有）。
 * - 给了 `baseUrl`：那是覆盖内置端点（本机端点、代理），人明确要改的东西。这种走
 *   「只覆盖」那一格，不声明模型 —— 声明了就是抄第二份目录。
 */
async function importFromCatalog(
  operation: Extract<ModelCatalogOperation, { kind: 'importCatalog' }>,
  registry: ModelRegistry,
  write: CatalogWrites,
): Promise<void> {
  const catalogId = operation.catalogId
  const id = operation.id ?? catalogId
  const baseUrl = operation.baseUrl ?? ''
  const rows = modelsOf(registry, catalogId)

  if (id !== catalogId) {
    if (rows.length === 0) {
      throw new Error(`no catalog entry is called ${catalogId}`)
    }

    await write.defineProvider({
      id,
      baseUrl: baseUrl === '' ? (rows[0]?.baseUrl ?? null) : baseUrl,
      api: rows[0]?.api ?? null,
      models: rows.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow ?? undefined,
        maxTokens: model.maxTokens ?? undefined,
        reasoning: model.reasoning,
        efforts: model.thinking?.efforts,
        input: model.input,
      })),
    })
  } else if (baseUrl !== '') {
    await write.overrideProvider(id, baseUrl, rows[0]?.api ?? null)
  }

  await writeKey(id, operation.apiKey, write)
  await write.enableProvider(id)
}

/* 钥匙是可选的：改一个已有 provider 时留空表示不动它，别把人的钥匙抹成空串。 */
async function writeKey(
  provider: string,
  apiKey: string | null | undefined,
  write: CatalogWrites,
): Promise<void> {
  if (apiKey !== null && apiKey !== undefined && apiKey !== '') {
    await write.apiKey(provider, apiKey)
  }
}

/** 注册表里某个 provider 的全部行；「从目录添加」读它来搬定义。 */
function modelsOf(registry: ModelRegistry, provider: string): readonly RegistryModel[] {
  const every = registry.getAll('all') as unknown as readonly RegistryModel[]

  return every.filter((model) => model.provider === provider)
}

/** 一次 provider 定义（models.yml 的 `providers.<id>` 那一行）。 */
export interface ProviderDefinition {
  readonly id: string
  readonly baseUrl: string | null
  readonly api: string | null
  readonly models: readonly {
    readonly id: string
    readonly name?: string | undefined
    readonly contextWindow?: number | undefined
    readonly maxTokens?: number | undefined
    readonly reasoning?: boolean | undefined
    readonly efforts?: readonly string[] | undefined
    readonly input?: readonly string[] | undefined
  }[]
}

/**
 * 界面那一份 provider 输入 → models.yml 的定义。
 *
 * `providerType` 是界面选的 API 格式（openai / anthropic / …），它在 omp 里就是
 * `api` 那一格；两个词说的是同一件事，转换只在这里做一次。
 *
 * **每一格都按「可能缺席、可能是 null」判。** 这份输入是从 Rust 那条 JSON 线上
 * 解出来的，`Option::None` 到这边是 `null` 而不是 `undefined`（protocol.ts 的
 * `ProviderModelInput` 写的是 `?: T | undefined`，那只是 TS 侧的形状，线上来的
 * 仍是 null）。`x === undefined` 挡不住 null，后面 `.length` 就会炸在
 * 「null is not an object」上 —— 这条已经发生过一次。
 */
export function definitionOf(
  provider: {
    readonly providerType: string
    readonly baseUrl?: string | null | undefined
    readonly models: readonly {
      readonly model: string
      readonly displayName?: string | null | undefined
      readonly maxContextSize: number
      readonly maxOutputSize?: number | null | undefined
      readonly supportEfforts?: readonly string[] | null | undefined
      readonly capabilities?: readonly string[] | null | undefined
    }[]
  },
  id: string,
): ProviderDefinition {
  return {
    id,
    baseUrl: provider.baseUrl ?? null,
    api: API_OF.get(provider.providerType) ?? provider.providerType,
    models: provider.models.map((model) => {
      const efforts = model.supportEfforts ?? []
      const displayName = model.displayName ?? undefined
      const maxOutputSize = model.maxOutputSize ?? undefined

      return {
        id: model.model,
        ...(displayName === undefined || displayName === '' ? {} : { name: displayName }),
        contextWindow: model.maxContextSize,
        ...(maxOutputSize === undefined ? {} : { maxTokens: maxOutputSize }),
        /* 有档位就是推理模型：界面那一栏填了档位，模型自己就得认这件事。 */
        ...(efforts.length === 0 ? {} : { reasoning: true, efforts }),
        ...(model.capabilities?.includes('image') === true ? { input: ['text', 'image'] } : {}),
      }
    }),
  }
}

/*
 * 界面那一列 API 格式 → 上游的 `api` 取值。
 *
 * 正本：models-config-schema-bundle.ts 的 ApiSchema（openai-completions /
 * openai-responses / anthropic-messages / google-generative-ai / google-vertex / …）
 * 与 models-settings.tsx 的 PROVIDER_TYPES（openai / openai_responses / anthropic /
 * kimi / google-genai / vertexai）。两张表的词不一样，逐条对齐只在这里做一次；
 * 认不出的原样透传，让上游的 schema 去拒 —— 这里不替它猜。
 */
const API_OF: ReadonlyMap<string, string> = new Map([
  ['openai', 'openai-completions'],
  ['openai_responses', 'openai-responses'],
  ['anthropic', 'anthropic-messages'],
  ['google-genai', 'google-generative-ai'],
  ['vertexai', 'google-vertex'],
])
