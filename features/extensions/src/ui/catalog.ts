/* MCP 名单页的数据层：**精选**（下面那 6 条，产品意图，离线可用）与**在线目录**（omp 的 Smithery
 * registry，实时检索）并存。精选不是「过时的硬编码」—— 它给的是「装上就能用、不用挑」的那几条，
 * 目录给的是长尾。两处的 `group` 一起进同一张分组表，界面不为它们写第二套。 */

import type { McpCatalogEntry } from '../contract'

export interface HttpTransport {
  readonly kind: 'http'
  readonly url: string
}

export interface StdioTransport {
  readonly kind: 'stdio'
  readonly command: string
  readonly args: readonly string[]
}

export type BuiltinTransport = HttpTransport | StdioTransport

export interface ServerInput {
  readonly label: string
  readonly placeholder: string
  readonly required: boolean
  readonly apply: (body: Record<string, unknown>, value: string) => Record<string, unknown>
}

export interface BuiltinServer {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly group: string
  readonly homepage: string
  readonly transport: BuiltinTransport
  readonly needs: string | undefined
  readonly input: ServerInput | undefined
}

export const BUILTIN_SERVERS: readonly BuiltinServer[] = [
  {
    id: 'context7',
    displayName: 'Context7',
    description: '按库名取回最新的官方文档片段，止住模型对着过时 API 编用法。',
    group: '精选',
    homepage: 'https://context7.com',
    transport: { kind: 'http', url: 'https://mcp.context7.com/mcp' },
    needs: undefined,
    input: undefined,
  },
  {
    id: 'deepwiki',
    displayName: 'DeepWiki',
    description: '对任意公开 GitHub 仓库提问：读目录、读正文、直接问一句。',
    group: '精选',
    homepage: 'https://deepwiki.com',
    transport: { kind: 'http', url: 'https://mcp.deepwiki.com/mcp' },
    needs: undefined,
    input: undefined,
  },
  {
    id: 'playwright',
    displayName: 'Playwright',
    description: '用可访问性树而不是截图驱动浏览器：导航、点击、填表、断言。',
    group: '浏览器与自动化',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    transport: { kind: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] },
    needs: undefined,
    input: undefined,
  },
  {
    id: 'chrome-devtools',
    displayName: 'Chrome DevTools',
    description: '接上 Chrome 调试协议：录性能轨迹、看网络请求、读控制台。',
    group: '浏览器与自动化',
    homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    transport: { kind: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@latest'] },
    needs: undefined,
    input: undefined,
  },
  {
    id: 'memory',
    displayName: 'Memory',
    description: '一张跨会话的知识图：把事实记下来，下一次接着用。',
    group: '本机能力',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    transport: {
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    needs: undefined,
    input: undefined,
  },
  {
    id: 'sequential-thinking',
    displayName: 'Sequential Thinking',
    description: '把一个复杂问题拆成可以回头修正的思考步骤。',
    group: '本机能力',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    transport: {
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
    needs: undefined,
    input: undefined,
  },
]

/** 写进 mcp.json 的那一条正文：远端一条 url，本地一条 command 加 args。新架构没有 launcher_resolve 通道，交出去的 command 就是
 * 名单里的逻辑程序名。 */
export function mcpServerBody(server: BuiltinServer, filled: string): Record<string, unknown> | null {
  const { transport } = server

  const body: Record<string, unknown> | null =
    transport.kind === 'http' ? { url: transport.url } : { command: transport.command, args: [...transport.args] }

  const value = filled.trim()

  if (body === null || server.input === undefined || value === '') {
    return body
  }

  return server.input.apply(body, value)
}

/**
 * 把用户补的输入合并进目录给的正文。**照抄 omp 自己的做法**（`#applyRegistryInputOverrides`）：
 * 只有 stdio 条目能把值写进去，落点是把值串成一个 JSON 交给 `--config` —— 目录里的命令是
 * `bunx @smithery/cli run <name> --config {}`，值就填在那个 `{}` 上。
 *
 * 远程条目（http/sse）拿这些值没用：它的凭据走 OAuth / 请求头，目录也不给 `--config` 的位置。
 * 所以这里对非 stdio 原样交回 —— 不假装填进去了。
 */
export function registryServerBody(
  entry: McpCatalogEntry,
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const config = { ...entry.config }
  const filled = Object.entries(values).filter(([, value]) => value.trim() !== '')

  if (filled.length === 0 || config.type !== 'stdio') {
    return config
  }

  const args = [...((config.args as string[] | undefined) ?? [])]
  const json = JSON.stringify(Object.fromEntries(filled.map(([key, value]) => [key, value.trim()])))
  const at = args.indexOf('--config')

  if (at >= 0) {
    if (at + 1 < args.length) args[at + 1] = json
    else args.push(json)
  } else {
    args.push('--config', json)
  }

  return { ...config, args }
}

/** 必填项里还空着的那些（`defaultValue` 视为已填）。界面据此禁用安装键并说明缺什么。 */
export function missingRegistryInputs(
  entry: McpCatalogEntry,
  values: Readonly<Record<string, string>>,
): readonly string[] {
  return entry.inputs
    .filter((input) => input.required && (values[input.key] ?? input.defaultValue ?? '').trim() === '')
    .map((input) => input.key)
}

/**
 * 目录名 → 可用的配置名（重名时按 omp 的规矩加 `-2`、`-3`…）。
 * 目录里的名字已由 Core 侧 `toConfigName` 归一过，这里只管去重。
 */
export function availableServerName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base

  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${base}-${String(index)}`

    if (!taken.has(candidate)) return candidate
  }

  return `${base}-${String(Date.now())}`
}

export type ListingStatus =
  | { readonly kind: 'installable' }
  | {
      readonly kind: 'installed'
      readonly installedVersion: string | undefined
      readonly catalogVersion: string | undefined
    }

export function statusText(status: ListingStatus): string {
  switch (status.kind) {
    case 'installable':
      return '可安装'
    case 'installed': {
      const here = status.installedVersion === undefined ? '已安装' : `已安装 · v${status.installedVersion}`

      if (status.catalogVersion === undefined || status.catalogVersion === status.installedVersion) {
        return here
      }

      return `${here} · 名单里是 v${status.catalogVersion}`
    }
  }
}

export interface CatalogRow {
  readonly key: string
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly group: string
  readonly status: ListingStatus
}

export interface RowGroup<T extends CatalogRow = CatalogRow> {
  readonly title: string
  readonly rows: readonly T[]
}

/* 分隔符取换行而不是空串，免得相邻两段拼接处凑出一个本不存在的匹配。 */
export function matches(needle: string, ...fields: readonly (string | undefined)[]): boolean {
  return needle === '' || fields.join('\n').toLowerCase().includes(needle.toLowerCase())
}

/* 已装的排最前。sort 自 ES2019 起规范要求稳定，同状态因此保持名单里的次序。 */
function ordered<T extends CatalogRow>(rows: readonly T[]): readonly T[] {
  return [...rows].sort((left, right) => rank(left) - rank(right))
}

function rank(row: CatalogRow): number {
  return row.status.kind === 'installed' ? 0 : 1
}

/* 组名是开放集合，写死一张全序表就意味着少一格。「精选」与「在线目录」各占一档且排最前：
 * 前者是产品挑的、后者是刚搜回来的，都比别处先看到。 */
const FEATURED = '精选'
const REGISTRY = '在线目录'
const LEAD: readonly string[] = [FEATURED, REGISTRY]

export function groupRows<T extends CatalogRow>(rows: readonly T[]): readonly RowGroup<T>[] {
  const buckets = new Map<string, T[]>()

  for (const row of rows) {
    const bucket = buckets.get(row.group)

    if (bucket === undefined) {
      buckets.set(row.group, [row])
      continue
    }

    bucket.push(row)
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => {
      if (left === right) {
        return 0
      }
      const leftLead = LEAD.indexOf(left)
      const rightLead = LEAD.indexOf(right)
      if (leftLead !== rightLead) {
        if (leftLead === -1) return 1
        if (rightLead === -1) return -1
        return leftLead - rightLead
      }

      return left.localeCompare(right)
    })
    .map(([title, bucket]) => ({ title, rows: ordered(bucket) }))
}

/** 「已装」的判据是名字出现在已解析的那张 MCP 表里 —— 那张表是唯一真相，不另存一份「我们装过什么」。 */
export function builtinServerRows(
  resolved: readonly { readonly name: string }[],
  needle: string,
): readonly CatalogRow[] {
  const present = new Set(resolved.map((server) => server.name))

  return BUILTIN_SERVERS.filter((server) => matches(needle, server.displayName, server.id, server.description)).map(
    (server): CatalogRow => ({
      key: `builtin/${server.id}`,
      id: server.id,
      displayName: server.displayName,
      description: server.description,
      group: server.group,
      status: present.has(server.id)
        ? { kind: 'installed', installedVersion: undefined, catalogVersion: undefined }
        : { kind: 'installable' },
    }),
  )
}

/**
 * 在线目录（Smithery）的一行。与精选行的差别：**配置正文与「要补什么值」由目录给**，界面不再自己拼
 * transport；「装没装」按归一后的配置名判（目录名带斜杠，写盘前已归一，判已装也得用同一个名字）。
 */
export interface CatalogEntryRow extends CatalogRow {
  readonly kind: 'registry'
  readonly entry: McpCatalogEntry
}

export function registryServerRows(
  entries: readonly McpCatalogEntry[],
  resolved: readonly { readonly name: string }[],
): readonly CatalogEntryRow[] {
  const present = new Set(resolved.map((server) => server.name))

  return entries.map((entry) => ({
    key: `registry/${entry.id}`,
    id: entry.name,
    displayName: entry.title,
    description: entry.description === '' ? entry.name : entry.description,
    group: '在线目录',
    status: present.has(entry.name)
      ? { kind: 'installed', installedVersion: undefined, catalogVersion: undefined }
      : { kind: 'installable' },
    kind: 'registry',
    entry,
  }))
}

/** 行是精选还是目录来的 —— 卡片据此决定动作区（一个要输入框，一个要「补完必填项」）。 */
export function isRegistryRow(row: CatalogRow): row is CatalogEntryRow {
  return 'kind' in row && row.kind === 'registry'
}
