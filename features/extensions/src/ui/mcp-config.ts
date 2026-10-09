import { z } from 'zod'

/*
 * MCP 配置的解析与校验。**逐字迁移**自 legacy `packages/extension/src/mcp-config.ts` 里
 * 与界面有关的那一半（`validateMcpEntry` / `parseMcpImport` / `mcpEntryFromForm`）。
 *
 * legacy 的另一半（读写 mcp.json 的 `upsertMcpServer` / `removeMcpServer` /
 * `setMcpServerEnabledInConfig`）没有迁过来：新架构的写盘由 omp 的 mcp config-writer
 * 经引擎端口完成（04 页 §MCP），UI 只负责把这一份形状交出去。
 */

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpEntry {
  readonly name: string
  readonly transport: McpTransport
  readonly config: Record<string, unknown>
}

/**
 * 表单校验的返回形状（C 类，09 页 §4 第 5 条）：
 * 用户输入不合法**不抛异常** —— 它由字段旁边的一句提示承接，不是一次失败。
 * 两处调用点（新建表单、批量导入）都按同一个形状读 `message`。
 */
export type McpValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

export function mcpOk<T>(value: T): McpValidation<T> {
  return { ok: true, value }
}

export function mcpInvalid<T>(message: string): McpValidation<T> {
  return { ok: false, message }
}

/* 这里只校验配置输入；协议和连接管理由 agent 自己的 MCP 客户端负责。 */
const Timeout = z.int().min(1).max(2_147_483_647)
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
  bearerTokenEnvVar: Nonempty.optional(),
  enabled: z.boolean().optional(),
  startupTimeoutMs: Timeout.optional(),
  toolTimeoutMs: Timeout.optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
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
    return mcpInvalid('名称不能为空或带首尾空格。')
  }
  const parsed = InputBody.safeParse(input)
  if (!parsed.success) {
    return mcpInvalid(
      '配置字段类型错误：参数须为字符串数组，环境变量/请求头须为字符串映射，超时须为 1–2147483647 的整数。',
    )
  }
  const body = parsed.data
  if (Object.hasOwn(body, 'type')) {
    return mcpInvalid('这份配置用 transport 而不是 type 字段；请按 stdio、http 或 sse 配置。')
  }
  const transport = body.transport ?? (body.command === undefined ? 'http' : 'stdio')
  if (transport === 'stdio') {
    if (body.command === undefined || body.url !== undefined) {
      return mcpInvalid('stdio 必须填写命令，不能同时填写 URL。')
    }
  } else {
    if (body.url === undefined || body.command !== undefined) {
      return mcpInvalid('远程服务必须填写 URL，不能同时填写命令。')
    }
    let url: URL
    try {
      url = new URL(body.url)
    } catch {
      return mcpInvalid('请输入完整的 HTTP 或 HTTPS 地址。')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      return mcpInvalid('仅支持 HTTP/HTTPS；凭据请使用环境变量引用或请求头，不要放进 URL。')
    }
  }
  /* 交回去的那一份把 transport 提到契约那一格，正文里的其余键原样留：omp 自己认它们。 */
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
      return args
    }
    body.args = args.value
    if (fields.cwd?.trim()) {
      body.cwd = fields.cwd.trim()
    }
    if (fields.env?.trim()) {
      const env = parseJson(fields.env)
      if (!env.ok) {
        return env
      }
      body.env = env.value
    }
  } else {
    body.url = fields.url?.trim() ?? ''
    if (fields.headers?.trim()) {
      const headers = parseJson(fields.headers)
      if (!headers.ok) {
        return headers
      }
      body.headers = headers.value
    }
    if (fields.bearerTokenEnvVar?.trim()) {
      body.bearerTokenEnvVar = fields.bearerTokenEnvVar.trim()
    }
  }
  if (fields.startupTimeoutMs?.trim()) {
    body.startupTimeoutMs = Number(fields.startupTimeoutMs)
  }
  return validateMcpEntry(fields.name?.trim() ?? '', body)
}
