/*
 * models.yml 的读改写：用户自建的 provider 定义住在那里。omp 的 SDK 只给了读者
 * （`ModelsConfigFile` 没有 save），没有官方 TUI 那个写文件的界面，所以由我们补上，
 * 写完它自己按 mtime 重读。三件事缺一条就会把用户的配置写坏：
 *
 * 1. 整份读、整份写：文件里还有用户手写的东西（headers、compat、modelOverrides…），
 *    只动 `providers.<id>` 那一格，其余原样带回去。
 * 2. 落盘先于可见：同目录临时文件 + rename，读者看不到写了一半的文件。
 * 3. 密钥不落这里：密钥只进 agent.db（`AuthStorage`），这里只写定义，一个地方存密钥。
 *
 * 认不出的内容一律如实报错，不拿一份空配置覆盖用户的东西。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 一次 provider 定义；字段名与 models.yml 的 `providers.<id>` 逐字对应。 */
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

/**
 * 写一个 provider 定义。
 *
 * `previousId` 给了就是改名：旧的那一格删掉，新的写进去。
 */
export async function writeProvider(
  file: string,
  provider: ModelsFileProvider,
  previousId?: string,
): Promise<void> {
  const document = await readModelsFile(file)
  const providers: Record<string, unknown> = { ...(document.providers ?? {}) }

  if (previousId !== undefined && previousId !== provider.id) {
    delete providers[previousId]
  }

  providers[provider.id] = {
    baseUrl: provider.baseUrl ?? undefined,
    api: provider.api ?? undefined,
    /*
     * `auth: none` 是必须的：上游校验（models-config.ts 的 validateProviderConfiguration）
     * 规定定义 `models` 时无 `apiKey` 必须 `auth: none`（或 oauth），否则整份配置无效。
     * 它说的是「这个文件不提供密钥」，不是「这个 provider 不要密钥」——
     * 请求时上游照旧去 agent.db（AuthStorage）取。
     */
    auth: 'none',
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      thinking:
        model.efforts === undefined || model.efforts.length === 0
          ? undefined
          : { mode: 'effort', efforts: model.efforts },
      input: model.input,
    })),
  }

  await writeModelsFile(file, { ...document, providers })
}

/**
 * 写一个**只覆盖**的 provider 定义：只动端点（baseUrl / api），不声明模型。
 *
 * 用在「从目录添加」上：模型清单在 omp 编进包里的目录里，声明 `models` 会把它挤掉，
 * 「从目录添加」就变成「用我抄的这几行」，上游换目录它也不跟。
 * 不写 `auth`：那格只在定义 `models` 时才需要（见 `writeProvider`），写了反而把
 * provider 变成 keyless，绕过人配的钥匙。
 */
export async function writeProviderOverride(
  file: string,
  provider: { readonly id: string; readonly baseUrl: string; readonly api: string | null },
): Promise<void> {
  const document = await readModelsFile(file)
  const providers: Record<string, unknown> = { ...(document.providers ?? {}) }
  const existing = providers[provider.id]

  providers[provider.id] = {
    ...(existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}),
    baseUrl: provider.baseUrl,
    api: provider.api ?? undefined,
  }

  await writeModelsFile(file, { ...document, providers })
}

/** 删一个 provider 定义。没有这一格就是没写过，不算失败。 */
export async function removeProvider(file: string, provider: string): Promise<void> {
  const document = await readModelsFile(file)

  if (document.providers === undefined || !(provider in document.providers)) {
    return
  }

  const providers: Record<string, unknown> = { ...document.providers }
  delete providers[provider]

  await writeModelsFile(file, { ...document, providers })
}

/**
 * 读整份 models.yml。
 *
 * 文件不在就是空文档（第一次配 provider 的正常情形）。读得动但解不开就报错 ——
 * 拿一份空文档覆盖上去等于把用户手写的 provider 全删了。
 */
async function readModelsFile(file: string): Promise<ModelsFile> {
  let text: string

  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw error
  }

  if (text.trim() === '') {
    return {}
  }

  const parsed: unknown = Bun.YAML.parse(text)

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} does not hold a YAML mapping; refusing to overwrite it`)
  }

  return parsed as ModelsFile
}

/**
 * 整份写回。同目录临时文件 + rename：读者要么看到旧的整份要么看到新的整份 ——
 * omp 按 mtime 重读，半个文件会让它把自定义 provider 全判为无效。
 *
 * 序列化必须带缩进参数：`Bun.YAML.stringify(value, null, 2)` 才出块状 YAML，不传出的
 * 是流式（`{providers: {x: {...}}}`）—— 合法 YAML 但 omp 的配置读取认不出来
 * （实测：写进去的 provider 读回来是 0 条）。官方也传 2（pi-utils 的 yaml-config.ts）。
 *
 * 值为 undefined 的格由序列化时丢掉：没填的字段不该在文件里留 null。
 */
async function writeModelsFile(file: string, document: ModelsFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })

  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, Bun.YAML.stringify(prune(document), null, 2), 'utf8')
  await rename(temporary, file)
}

/** 丢掉 undefined 与空对象，免得写出一串空壳。 */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(prune)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  const kept: Record<string, unknown> = {}

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) {
      continue
    }

    const pruned = prune(entry)

    if (pruned !== null && typeof pruned === 'object' && Object.keys(pruned).length === 0) {
      continue
    }

    kept[key] = pruned
  }

  return kept
}
