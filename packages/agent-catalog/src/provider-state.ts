/**
 * agent 已配置的 provider 与模型。
 *
 * 产地是 agent 官方 CLI 的 provider list --json，不是我们自己的任何一份缓存。
 * 模式 B 下权威在 agent 的配置文件里，这里只做一次只读投影。
 *
 * 这个模块同时是一道闸门。kimi 的 --json 分支把它的 providers 与 models 两张表
 * 原样序列化出来，而那两张表里有四处可能装着明文 API key：
 *
 *   - providers[id].apiKey
 *   - providers[id].source.apiKey（apiJson 来源会把 key 一起存下来）
 *   - providers[id].env（官方文档把 [providers.x.env] 列为合法凭据位置）
 *   - models[alias].apiKey
 *
 * 而 models 的 schema 结尾是 passthrough，未知字段原样透传。因此这里的解析是
 * 白名单：只挑下面这些接口声明了的字段，其余一律不越过这条边界。黑名单挡不住
 * passthrough，也挡不住上游下一次加字段。
 *
 * 渲染层拿到的关于凭据的全部信息就是 configured 与 credentialKind：配没配过、
 * 配的是哪一类。值本身不出现在返回结构里的任何位置。
 *
 * 解析刻意宽容：坏条目被跳过并记一条 issue，不会让整份投影失败。一个手改坏的
 * config.toml 不该让设置页白屏。
 */

/** 凭据的种类。值永远不出现在这里。 */
export type AgentCredentialKind = 'apiKey' | 'env' | 'oauth' | 'none'

/** 一个模型别名。别名的形状是 <providerId>/<modelId>。 */
export interface AgentModelState {
  /** 配置里的 record key，也是 ACP 会话里用来选模型的那个 id。 */
  readonly alias: string
  /** 给人看的名字。取不到就退回别名。 */
  readonly displayName: string
  readonly providerId: string | undefined
  readonly maxContextSize: number | undefined
  readonly capabilities: readonly string[]
  /** 支持的思考档位，例如 low / medium / high。 */
  readonly supportEfforts: readonly string[]
}

export interface AgentProviderState {
  readonly id: string
  /** provider 协议类型。上游刻意不枚举 vendor，所以这里也只当它是文本。 */
  readonly type: string | undefined
  readonly baseUrl: string | undefined
  /** 配没配过凭据。等价于 credentialKind 不是 none。 */
  readonly configured: boolean
  readonly credentialKind: AgentCredentialKind
  /** 自定义注册表来源的地址。key 不带出来。 */
  readonly registryUrl: string | undefined
  /**
   * 由环境变量合成的保留条目，不是用户配置的。
   *
   * 上游用一个固定 id 把 KIMI_MODEL_API_KEY 之类的变量合成成一个 provider，
   * 并在落盘时把它剥掉。它会出现在 provider list 的输出里，但界面不该把它当成
   * 可编辑或可删除的条目。
   */
  readonly synthetic: boolean
  readonly models: readonly AgentModelState[]
}

export interface AgentProviderSnapshot {
  readonly providers: readonly AgentProviderState[]
  /** 指向了不存在的 provider 的模型别名。配置坏了才会有。 */
  readonly orphanModels: readonly AgentModelState[]
  readonly issues: readonly string[]
}

const MAX_PROVIDERS = 64
const MAX_MODELS = 512

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined
  }

  return input as Record<string, unknown>
}

function asText(input: unknown): string | undefined {
  return typeof input === 'string' && input.length > 0 ? input : undefined
}

function asCount(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : undefined
}

function asTextList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return []
  }

  const list: string[] = []

  for (const candidate of input) {
    const value = asText(candidate)

    if (value !== undefined && !list.includes(value)) {
      list.push(value)
    }
  }

  return list
}

/** 有没有一个非空的值。用来判断 env 子表里是不是真的放了凭据。 */
function hasValue(input: unknown): boolean {
  const table = asRecord(input)

  if (!table) {
    return false
  }

  return Object.values(table).some((value) => asText(value) !== undefined)
}

/**
 * 判断凭据的种类。
 *
 * 顺序照官方文档的凭据优先级：api_key 直接字段 > [providers.x.env] 子表。oauth
 * 排在最前，因为它走的是另一条路（凭据是 credentials 目录下的文件，不是这里的
 * 任何字段），一旦存在就与 apiKey 无关。
 */
function credentialKindOf(raw: Record<string, unknown>): AgentCredentialKind {
  if (asRecord(raw['oauth']) !== undefined) {
    return 'oauth'
  }

  if (asText(raw['apiKey']) !== undefined) {
    return 'apiKey'
  }

  if (hasValue(raw['env'])) {
    return 'env'
  }

  return 'none'
}

/** 自定义注册表的地址。同一个 source 里还有一份 key，不取。 */
function registryUrlOf(raw: Record<string, unknown>): string | undefined {
  const source = asRecord(raw['source'])

  if (!source) {
    return undefined
  }

  return asText(source['url'])
}

function parseModel(alias: string, input: unknown): AgentModelState | undefined {
  const raw = asRecord(input)

  if (!raw) {
    return undefined
  }

  /*
   * provider 归属有三个来源，可靠性递减：显式的 provider 字段、providerId，
   * 最后是别名前缀。别名的形状是约定而不是校验过的东西，所以它排最后。
   */
  const declared = asText(raw['provider']) ?? asText(raw['providerId'])
  const prefix = alias.includes('/') ? asText(alias.slice(0, alias.indexOf('/'))) : undefined

  return {
    alias,
    displayName: asText(raw['displayName']) ?? asText(raw['name']) ?? alias,
    providerId: declared ?? prefix,
    maxContextSize: asCount(raw['maxContextSize']),
    capabilities: asTextList(raw['capabilities']),
    supportEfforts: asTextList(raw['supportEfforts']),
  }
}

function parseModels(input: unknown): {
  readonly models: readonly AgentModelState[]
  readonly issues: readonly string[]
} {
  const raw = asRecord(input)

  if (!raw) {
    return { models: [], issues: [] }
  }

  const models: AgentModelState[] = []
  const issues: string[] = []

  const entries = Object.entries(raw)

  /* 越过上限的那些也是一次跳过，与坏条目同一条规矩：说出来，不静默丢。 */
  if (entries.length > MAX_MODELS) {
    issues.push(`模型条目超过上限 ${String(MAX_MODELS)} 条，其余未载入。`)
  }

  for (const [alias, candidate] of entries.slice(0, MAX_MODELS)) {
    const model = parseModel(alias, candidate)

    if (model === undefined) {
      issues.push(`模型条目无法解析，已跳过：${alias}`)
      continue
    }

    models.push(model)
  }

  return { models, issues }
}

function parseProvider(
  id: string,
  input: unknown,
  models: readonly AgentModelState[],
  syntheticProviderId: string | undefined,
): AgentProviderState | undefined {
  const raw = asRecord(input)

  if (!raw) {
    return undefined
  }

  const credentialKind = credentialKindOf(raw)

  return {
    id,
    type: asText(raw['type']),
    baseUrl: asText(raw['baseUrl']),
    configured: credentialKind !== 'none',
    credentialKind,
    registryUrl: registryUrlOf(raw),
    synthetic: syntheticProviderId !== undefined && id === syntheticProviderId,
    models: models.filter((model) => model.providerId === id),
  }
}

/**
 * 把 provider list --json 的响应体投影成界面要的形状。
 *
 * 无法解析时返回空投影加一条 issue，不抛错：拿不到列表和列表是空的，对界面是
 * 同一种处置（提示 + 让用户去配），而抛错只会多一个要在调用点接住的分支。
 */
/* syntheticProviderId 由调用方从 agent 档案取；这一层不认识任何一家。 */
export function parseAgentProviderList(
  input: unknown,
  syntheticProviderId: string | undefined,
): AgentProviderSnapshot {
  const raw = asRecord(input)

  if (!raw) {
    return { providers: [], orphanModels: [], issues: ['provider 列表不是一个对象'] }
  }

  const parsedModels = parseModels(raw['models'])
  const issues = [...parsedModels.issues]
  const providerTable = asRecord(raw['providers'])

  if (!providerTable) {
    issues.push('provider 表不是一个对象')

    return { providers: [], orphanModels: parsedModels.models, issues }
  }

  const providers: AgentProviderState[] = []

  const table = Object.entries(providerTable)

  if (table.length > MAX_PROVIDERS) {
    issues.push(`provider 条目超过上限 ${String(MAX_PROVIDERS)} 条，其余未载入。`)
  }

  for (const [id, candidate] of table.slice(0, MAX_PROVIDERS)) {
    const provider = parseProvider(id, candidate, parsedModels.models, syntheticProviderId)

    if (provider === undefined) {
      issues.push(`provider 条目无法解析，已跳过：${id}`)
      continue
    }

    providers.push(provider)
  }

  providers.sort((left, right) => left.id.localeCompare(right.id))

  const known = new Set(providers.map((provider) => provider.id))
  const orphanModels = parsedModels.models.filter((model) => {
    return model.providerId === undefined || !known.has(model.providerId)
  })

  for (const orphan of orphanModels) {
    issues.push(`模型指向了不存在的 provider：${orphan.alias}`)
  }

  return { providers, orphanModels, issues }
}

/**
 * 解析 provider list --json 的 stdout。
 *
 * CLI 的正常输出就是一段 JSON，但它也可能什么都没写（配置文件坏了会走 stderr
 * 并以非零退出）。所以这里连 JSON.parse 一起接住。
 */
export function parseAgentProviderListOutput(
  stdout: string,
  syntheticProviderId: string | undefined,
): AgentProviderSnapshot {
  const trimmed = stdout.trim()

  if (trimmed.length === 0) {
    return { providers: [], orphanModels: [], issues: ['agent 没有输出 provider 列表'] }
  }

  try {
    return parseAgentProviderList(JSON.parse(trimmed), syntheticProviderId)
  } catch {
    return { providers: [], orphanModels: [], issues: ['provider 列表不是合法的 JSON'] }
  }
}

/* importDocument（今在 kimi/catalog.ts）曾在这里。它需要查内置表补显示名，
 * 而内置表（provider-presets.ts）反过来查快照类型就成环了 —— 依赖只许一个方向。 */
