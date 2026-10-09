import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CustomProviderDef } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import { writeFileAtomic } from '@poietica/fs-kit'

/**
 * models.yml 的读写：用户自建的 provider 定义住在那里（<ompAgentDir>/models.yml）。
 * omp 的 SDK 只给了读者（ModelsConfigFile 没有 save），所以写由我们补上；写完它自己按
 * mtime 重读。三条规则缺一条就会把用户的配置写坏：
 *
 * 1. 整份读、整份写：文件里还有用户手写的东西（headers、compat、modelOverrides…），
 *    只动 providers.<id> 那一格，其余原样带回去。
 * 2. 落盘先于可见：fs-kit 的 writeFileAtomic（同目录临时文件 + fsync + rename），
 *    读者要么看到旧的整份要么看到新的整份 —— omp 按 mtime 重读，半个文件会让它把
 *    自定义 provider 全判为无效。
 * 3. 写完让 registry 重新读取（reload 回调），否则界面上的模型目录要等下次启动才更新。
 *
 * 密钥不落这里：密钥只进 agent.db（AuthStorage），这里只写定义，一个地方存密钥。
 * 认不出的内容一律如实报错，不拿一份空配置覆盖用户的东西。
 */

/** 一次 provider 定义；字段名与 models.yml 的 providers.<id> 逐字对应。 */
export interface ModelsFileProvider {
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

/** models.yml 的形状；我们只认 providers 那一格，其余原样留着。 */
interface ModelsFile {
  readonly [key: string]: unknown
  readonly providers?: Record<string, unknown>
}

/** omp 的 models.yml 路径（model-registry.ts：path.join(getAgentDir(), 'models.yml')）。 */
export function modelsFilePath(ompAgentDir: string): string {
  return path.join(ompAgentDir, 'models.yml')
}

export interface CustomProvidersFileDeps {
  readonly file: string
  readonly logger: Logger
  /** 规则 3：写完让 registry 重新读取（OmpEngine 传 registry.refresh）。 */
  readonly reload: () => Promise<void> | void
}

export class CustomProvidersFile {
  constructor(private readonly d: CustomProvidersFileDeps) {}

  /** 写一个 provider 定义；previousId 给了就是改名：旧的那一格删掉，新的写进去。 */
  async upsert(def: CustomProviderDef, previousId?: string): Promise<void> {
    const document = await readModelsFile(this.d.file)
    const providers: Record<string, unknown> = { ...(document.providers ?? {}) }
    if (previousId !== undefined && previousId !== def.id) delete providers[previousId]
    providers[def.id] = providerEntryOf(def)
    await this.write({ ...document, providers })
  }

  /** 只覆盖端点（baseUrl / api），不声明模型：用在「从目录添加」上，模型清单在 omp 目录里。 */
  async override(id: string, baseUrl: string, api: string | null): Promise<void> {
    const document = await readModelsFile(this.d.file)
    const providers: Record<string, unknown> = { ...(document.providers ?? {}) }
    const existing = providers[id]
    providers[id] = {
      ...(existing !== null && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {}),
      baseUrl,
      ...(api === null ? {} : { api }),
    }
    await this.write({ ...document, providers })
  }

  /** 删一个 provider 定义。没有这一格就是没写过，不算失败。 */
  async remove(id: string): Promise<void> {
    const document = await readModelsFile(this.d.file)
    if (document.providers === undefined || !(id in document.providers)) return
    const providers: Record<string, unknown> = { ...document.providers }
    delete providers[id]
    await this.write({ ...document, providers })
  }

  /** 文件里有没有这个 provider 的定义（「自定义 provider」的判据）。 */
  async defined(id: string): Promise<boolean> {
    const document = await readModelsFile(this.d.file)
    return document.providers !== undefined && id in document.providers
  }

  /** 规则 2 + 规则 3：原子写，然后让 registry 重读。 */
  private async write(document: ModelsFile): Promise<void> {
    await writeFileAtomic(this.d.file, Bun.YAML.stringify(prune(document), null, 2) as string)
    await this.d.reload()
  }
}

/** 界面那一份 provider 定义 → models.yml 的 providers.<id>。 */
function providerEntryOf(def: CustomProviderDef): Record<string, unknown> {
  return {
    baseUrl: def.baseUrl,
    api: def.api,
    /*
     * auth: none 是必须的：上游校验（models-config.ts 的 validateProviderConfiguration）
     * 规定定义 models 时无 apiKey 必须 auth: none（或 oauth），否则整份配置无效。
     * 它说的是「这个文件不提供密钥」，不是「这个 provider 不要密钥」—— 请求时上游照旧
     * 去 agent.db（AuthStorage）取。
     */
    auth: 'none',
    models: def.models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow ?? undefined,
      reasoning: model.reasoning,
      input: model.vision ? ['text', 'image'] : undefined,
    })),
  }
}

/**
 * 读整份 models.yml。文件不在就是空文档（第一次配 provider 的正常情形）。
 * 读得动但解不开就报错 —— 拿一份空文档覆盖上去等于把用户手写的 provider 全删了。
 */
async function readModelsFile(file: string): Promise<ModelsFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  if (text.trim() === '') return {}
  const parsed: unknown = Bun.YAML.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(SystemErrorCode.io, `${file} 不是一份 YAML 映射，拒绝覆盖它`)
  }
  return parsed as ModelsFile
}

/**
 * 序列化必须带缩进参数：Bun.YAML.stringify(value, null, 2) 才出块状 YAML，不传出的是
 * 流式（{providers: {x: {...}}}）—— 合法 YAML 但 omp 的配置读取认不出来。
 * 值为 undefined 的格由 prune 丢掉：没填的字段不该在文件里留 null。
 */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune)
  if (value === null || typeof value !== 'object') return value
  const kept: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue
    const pruned = prune(entry)
    if (pruned !== null && typeof pruned === 'object' && Object.keys(pruned).length === 0) continue
    kept[key] = pruned
  }
  return kept
}
