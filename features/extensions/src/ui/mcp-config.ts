import { z } from 'zod'

/* MCP 配置的解析与校验。legacy 的另一半（读写 mcp.json）没有迁过来：新架构的写盘由 omp 的 mcp config-writer 经引擎端口完成。 */

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpEntry {
  readonly name: string
  readonly transport: McpTransport
  readonly config: Record<string, unknown>
}

/** 出错的那一格。有它错误就落在输入框旁边，没有就落到底部那块公共横幅（导入解析这类不指向某一格的失败）。 */
export type McpField = 'name' | 'transport' | 'timeout' | 'command' | 'args' | 'cwd' | 'url' | 'headers' | 'env'

/** 用户输入不合法**不抛异常** —— 它由字段旁边的一句提示承接，不是一次失败；两处调用点都按同一个形状读 message。 */
export type McpValidation<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string; readonly field?: McpField }

export function mcpOk<T>(value: T): McpValidation<T> {
  return { ok: true, value }
}

export function mcpInvalid<T>(message: string, field?: McpField): McpValidation<T> {
  return field === undefined ? { ok: false, message } : { ok: false, message, field }
}

/**
 * 与 omp 的 `mcp/config-writer.ts` 的 `validateServerName` 同一条判据（字母数字与 `_ . - :`，词之间只允许
 * 单个空格，最长 100）。写盘前 omp 还会再查一遍 —— 这里只是把错误提前到那一格旁边。
 */
const SERVER_NAME = /^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$/

export function serverNameError(name: string): string | null {
  if (name === '') return '名称不能为空。'
  if (name.length > 100) return '名称最长 100 个字符。'
  if (!SERVER_NAME.test(name)) {
    return '名称只能包含字母、数字、连字符、下划线、点与冒号；词之间只允许一个空格。'
  }
  return null
}

/** omp 的 `timeout` 以 0 表示关闭客户端超时（`mcp/types.ts`）。 */
const Timeout = z.int().min(0).max(2_147_483_647)
const Nonempty = z.string().refine((value) => value.trim().length > 0)
const Strings = z.record(z.string(), z.string())
const InputBody = z.looseObject({
  command: Nonempty.optional(),
  args: z.array(z.string()).optional(),
  url: Nonempty.optional(),
  transport: z.enum(['stdio', 'http', 'sse']).optional(),
  env: Strings.optional(),
  cwd: z.string().optional(),
  headers: Strings.optional(),
  enabled: z.boolean().optional(),
  timeout: Timeout.optional(),
})

function parseJson(contents: string): McpValidation<unknown> {
  try {
    return mcpOk(JSON.parse(contents))
  } catch {
    // JSON.parse 的诊断可能包含密钥片段，不能交给日志或错误横幅。
    return mcpInvalid('配置不是有效 JSON，请检查引号、逗号和括号。')
  }
}

export function validateMcpEntry(name: string, input: unknown): McpValidation<McpEntry> {
  if (name.trim() === '' || name !== name.trim()) {
    return mcpInvalid('名称不能为空或带首尾空格。', 'name')
  }
  const nameError = serverNameError(name)
  if (nameError !== null) {
    return mcpInvalid(nameError, 'name')
  }
  const parsed = InputBody.safeParse(input)
  if (!parsed.success) {
    /* 只有 `timeout` 一格能指认得出来（其余失败可能是多个键一起错），能指认就贴到那一格旁边。 */
    const onTimeout = parsed.error.issues.some((issue) => issue.path.length === 1 && issue.path[0] === 'timeout')
    return mcpInvalid(
      '配置字段类型错误：参数须为字符串数组，环境变量/请求头须为字符串映射，超时须为 0–2147483647 的整数。',
      onTimeout ? 'timeout' : undefined,
    )
  }
  const body = parsed.data
  if (Object.hasOwn(body, 'type')) {
    return mcpInvalid('这份配置用 transport 而不是 type 字段；请按 stdio、http 或 sse 配置。', 'transport')
  }
  const transport = body.transport ?? (body.command === undefined ? 'http' : 'stdio')
  if (transport === 'stdio') {
    if (body.command === undefined || body.url !== undefined) {
      return mcpInvalid('stdio 必须填写命令，不能同时填写 URL。', 'command')
    }
  } else {
    if (body.url === undefined || body.command !== undefined) {
      return mcpInvalid('远程服务必须填写 URL，不能同时填写命令。', 'url')
    }
    let url: URL
    try {
      url = new URL(body.url)
    } catch {
      return mcpInvalid('请输入完整的 HTTP 或 HTTPS 地址。', 'url')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      return mcpInvalid('仅支持 HTTP/HTTPS；凭据请使用环境变量引用或请求头，不要放进 URL。', 'url')
    }
  }
  /* transport 提到契约那一格，正文里的其余键原样留：omp 自己认它们。 */
  const { transport: _transport, ...config } = input as Record<string, unknown>
  return mcpOk({ name, transport, config })
}

export function parseMcpImport(contents: string): McpValidation<readonly McpEntry[]> {
  const json = parseJson(contents)
  if (!json.ok) {
    return json
  }
  const input = json.value
  if (!z.looseObject({}).safeParse(input).success) {
    return mcpInvalid('导入内容必须是 JSON 对象。')
  }
  const raw = input as Record<string, unknown>
  const wrapped = Object.hasOwn(raw, 'mcpServers')
  if (wrapped && Object.keys(raw).some((key) => key !== 'mcpServers')) {
    return mcpInvalid('批量导入只接受 mcpServers；请去掉外层其他配置，避免静默丢弃。')
  }
  const source = wrapped ? raw.mcpServers : raw
  if (!z.looseObject({}).safeParse(source).success) {
    return mcpInvalid('mcpServers 必须是对象。')
  }
  const entries = Object.entries(source as Record<string, unknown>)
  if (entries.length === 0) {
    return mcpInvalid('至少需要一台服务器。')
  }
  const out: McpEntry[] = []
  for (const [name, body] of entries) {
    const entry = validateMcpEntry(name, body)
    if (!entry.ok) {
      return entry
    }
    out.push(entry.value)
  }
  return mcpOk(out)
}

export function mcpEntryFromForm(fields: Readonly<Record<string, string>>): McpValidation<McpEntry> {
  const body: Record<string, unknown> = {}
  const transport = fields.transport === 'http' || fields.transport === 'sse' ? fields.transport : 'stdio'
  body.transport = transport
  if (transport === 'stdio') {
    body.command = fields.command?.trim() ?? ''
    const args = parseJson(fields.args?.trim() || '[]')
    if (!args.ok) {
      return mcpInvalid(args.message, 'args')
    }
    body.args = args.value
    if (fields.cwd?.trim()) {
      body.cwd = fields.cwd.trim()
    }
    if (fields.env?.trim()) {
      const env = parseJson(fields.env)
      if (!env.ok) {
        return mcpInvalid(env.message, 'env')
      }
      body.env = env.value
    }
  } else {
    body.url = fields.url?.trim() ?? ''
    if (fields.headers?.trim()) {
      const headers = parseJson(fields.headers)
      if (!headers.ok) {
        return mcpInvalid(headers.message, 'headers')
      }
      body.headers = headers.value
    }
  }
  /* 空着就不写键：omp 自己按默认值处理（请求超时默认 30000ms）。 */
  if (fields.timeout?.trim()) {
    body.timeout = Number(fields.timeout.trim())
  }
  return validateMcpEntry(fields.name?.trim() ?? '', body)
}
