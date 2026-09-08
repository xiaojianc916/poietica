import * as v from 'valibot'
import type { ContributionOrigin } from './origin'

export interface DeclaredMcpServer {
  readonly name: string
  readonly origin: ContributionOrigin
  readonly enabledInConfig: boolean
}

export interface McpConfigDecoding {
  readonly servers: readonly DeclaredMcpServer[]
  readonly malformed: boolean
}

const IsObject = v.check<unknown>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
)
const ObjectValue = v.pipe(v.unknown(), IsObject, v.looseObject({}))
const ServerEntry = v.pipe(
  v.unknown(),
  IsObject,
  v.looseObject({ enabled: v.optional(v.boolean()) }),
)
const ServerMap = v.pipe(v.unknown(), IsObject, v.record(v.string(), ServerEntry))
const McpConfigDocument = v.pipe(
  v.unknown(),
  IsObject,
  v.looseObject({ mcpServers: v.optional(ServerMap) }),
)

function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents)
  } catch {
    // JSON.parse 的诊断可能包含密钥片段，不能交给日志或错误横幅。
    throw new Error('配置不是有效 JSON，请检查引号、逗号和括号。')
  }
}

type McpDocument = Record<string, unknown> & {
  readonly mcpServers?: Record<string, Record<string, unknown>>
}

function checkedDocument(input: unknown): McpDocument | undefined {
  if (!v.safeParse(McpConfigDocument, input).success) {
    return undefined
  }
  const document = input as McpDocument
  // 校验不承担序列化：保留输入中的所有自有字段，包括特殊名称。
  if (
    Object.values(document.mcpServers ?? {}).some(
      (entry) => !v.safeParse(ServerEntry, entry).success,
    )
  ) {
    return undefined
  }
  return document
}

function parseForEdit(contents: string | null): McpDocument {
  const document = checkedDocument(contents === null ? {} : parseJson(contents))
  if (document === undefined) {
    throw new Error('mcp.json 必须是对象，mcpServers 必须是服务器对象映射；未修改文件。')
  }
  return document
}

export function decodeMcpConfig(origin: ContributionOrigin, input: unknown): McpConfigDecoding {
  const document = checkedDocument(input)
  if (document === undefined) {
    return { servers: [], malformed: true }
  }
  return {
    servers: Object.entries(document.mcpServers ?? {}).map(([name, entry]) => ({
      name,
      origin,
      enabledInConfig: entry['enabled'] !== false,
    })),
    malformed: false,
  }
}

function editServers(
  contents: string | null,
  edit: (servers: Map<string, Record<string, unknown>>) => void,
): string {
  const document = parseForEdit(contents)
  const servers = new Map<string, Record<string, unknown>>(
    Object.entries(document.mcpServers ?? {}),
  )
  edit(servers)
  return `${JSON.stringify({ ...document, mcpServers: Object.fromEntries(servers) }, null, 2)}\n`
}

export function mcpServerBodyInConfig(
  contents: string | null,
  name: string,
): Record<string, unknown> | undefined {
  const servers = parseForEdit(contents).mcpServers
  return servers !== undefined && Object.hasOwn(servers, name) ? servers[name] : undefined
}

export function upsertMcpServer(
  contents: string | null,
  name: string,
  body: Record<string, unknown>,
): string {
  return editServers(contents, (servers) => {
    servers.set(name, body)
  })
}

export function removeMcpServer(contents: string | null, name: string): string {
  return editServers(contents, (servers) => {
    servers.delete(name)
  })
}

export function setMcpServerEnabledInConfig(
  contents: string | null,
  name: string,
  enabled: boolean,
): string {
  return editServers(contents, (servers) => {
    const entry = servers.get(name)
    if (entry === undefined) {
      throw new Error('服务器已经不存在，请刷新列表。')
    }
    const { enabled: _enabled, ...body } = entry
    servers.set(name, enabled ? body : { ...body, enabled: false })
  })
}

// 这里只校验配置输入；协议和连接管理由 Kimi 的 MCP SDK 客户端负责。
const Timeout = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_147_483_647))
const Nonempty = v.pipe(
  v.string(),
  v.check((value) => value.trim().length > 0),
)
const Strings = v.pipe(v.unknown(), IsObject, v.record(v.string(), v.string()))
const InputBody = v.pipe(
  v.unknown(),
  IsObject,
  v.looseObject({
    command: v.optional(Nonempty),
    args: v.optional(v.array(v.string())),
    url: v.optional(Nonempty),
    transport: v.optional(v.picklist(['stdio', 'http', 'sse'])),
    env: v.optional(Strings),
    cwd: v.optional(v.string()),
    headers: v.optional(Strings),
    bearerTokenEnvVar: v.optional(Nonempty),
    enabled: v.optional(v.boolean()),
    startupTimeoutMs: v.optional(Timeout),
    toolTimeoutMs: v.optional(Timeout),
    enabledTools: v.optional(v.array(v.string())),
    disabledTools: v.optional(v.array(v.string())),
  }),
)

export interface McpEntry {
  readonly name: string
  readonly body: Record<string, unknown>
}

export function validateMcpEntry(name: string, input: unknown): McpEntry {
  if (name.trim() === '' || name !== name.trim()) {
    throw new Error('名称不能为空或带首尾空格。')
  }
  const parsed = v.safeParse(InputBody, input)
  if (!parsed.success) {
    throw new Error(
      '配置字段类型错误：参数须为字符串数组，环境变量/请求头须为字符串映射，超时须为 1–2147483647 的整数。',
    )
  }
  const body = parsed.output
  if (Object.hasOwn(body, 'type')) {
    throw new Error('Kimi 使用 transport 而不是 type 字段；请按 stdio、http 或 sse 配置。')
  }
  const transport = body.transport ?? (body.command === undefined ? 'http' : 'stdio')
  if (transport === 'stdio') {
    if (body.command === undefined || body.url !== undefined) {
      throw new Error('stdio 必须填写命令，不能同时填写 URL。')
    }
  } else {
    if (body.url === undefined || body.command !== undefined) {
      throw new Error('远程服务必须填写 URL，不能同时填写命令。')
    }
    let url: URL
    try {
      url = new URL(body.url)
    } catch {
      throw new Error('请输入完整的 HTTP 或 HTTPS 地址。')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      throw new Error('仅支持 HTTP/HTTPS；凭据请使用环境变量引用或请求头，不要放进 URL。')
    }
  }
  return { name, body: input as Record<string, unknown> }
}

export function parseMcpImport(contents: string): readonly McpEntry[] {
  const input = parseJson(contents)
  if (!v.safeParse(ObjectValue, input).success) {
    throw new Error('导入内容必须是 JSON 对象。')
  }
  const raw = input as Record<string, unknown>
  const wrapped = Object.hasOwn(raw, 'mcpServers')
  if (wrapped && Object.keys(raw).some((key) => key !== 'mcpServers')) {
    throw new Error('批量导入只接受 mcpServers；请去掉外层其他配置，避免静默丢弃。')
  }
  const source = wrapped ? raw['mcpServers'] : raw
  if (!v.safeParse(ObjectValue, source).success) {
    throw new Error('mcpServers 必须是对象。')
  }
  const entries = Object.entries(source as Record<string, unknown>)
  if (entries.length === 0) {
    throw new Error('至少需要一台服务器。')
  }
  return entries.map(([name, body]) => validateMcpEntry(name, body))
}

export function addMcpServers(contents: string | null, entries: readonly McpEntry[]): string {
  if (entries.length === 0) {
    throw new Error('请选择至少一台服务器。')
  }
  return editServers(contents, (servers) => {
    for (const entry of entries) {
      const checked = validateMcpEntry(entry.name, entry.body)
      if (servers.has(checked.name)) {
        throw new Error('存在同名服务器；请更名后重试，不会覆盖已有配置。')
      }
      servers.set(checked.name, checked.body)
    }
  })
}

export function mcpEntryFromForm(
  fields: Readonly<Record<string, string>>,
  extra: Record<string, unknown>,
  validate = true,
): McpEntry {
  const body = { ...extra }
  for (const key of [
    'command',
    'args',
    'cwd',
    'env',
    'url',
    'headers',
    'bearerTokenEnvVar',
    'startupTimeoutMs',
    'transport',
  ]) {
    delete body[key]
  }
  const transport = fields['transport'] ?? 'stdio'
  body['transport'] = transport
  if (transport === 'stdio') {
    body['command'] = fields['command']?.trim() ?? ''
    body['args'] = parseJson(fields['args']?.trim() || '[]')
    if (fields['cwd']?.trim()) {
      body['cwd'] = fields['cwd'].trim()
    }
    if (fields['env']?.trim()) {
      body['env'] = parseJson(fields['env'])
    }
  } else {
    body['url'] = fields['url']?.trim() ?? ''
    if (fields['headers']?.trim()) {
      body['headers'] = parseJson(fields['headers'])
    }
    if (fields['bearerTokenEnvVar']?.trim()) {
      body['bearerTokenEnvVar'] = fields['bearerTokenEnvVar'].trim()
    }
  }
  if (fields['startupTimeoutMs']?.trim()) {
    body['startupTimeoutMs'] = Number(fields['startupTimeoutMs'])
  }
  const name = fields['name']?.trim() ?? ''
  return validate ? validateMcpEntry(name, body) : { name, body }
}
