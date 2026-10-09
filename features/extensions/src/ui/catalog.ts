/*
 * MCP 名单页的数据层。**迁移自** legacy `packages/extension/src/catalog/builtin.ts`（名单正文）
 * 与 `catalog/listing.ts`（分组 / 搜索 / 状态文案），去掉插件那半边 —— 新架构里「插件」
 * 设置页已按产品要求删除（见 docs/refactor-log.md 偏差 19），名单页只剩 MCP 服务器。
 *
 * 与 legacy 的两处差距（见 docs/refactor-log.md 偏差 25）：
 *   - legacy 的 stdio 条目在安装时经原生 `launcher_resolve` 把逻辑程序名解析成这台机器上的
 *     启动式；新架构没有这条通道，写进配置的就是 `npx` 本身（与 legacy 解析不到时一样跑得起来
 *     才怪，但这一层不该自己造一条假的解析）；
 *   - legacy 的 `ListingStatus` 还有 `elsewhere`（命令行里装过）与两个版本号并列，
 *     新契约的 `McpServerInfo` 只有名字与开关，「命令行里装过」没有数据来源。
 */

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
  /** 空着能不能装。 */
  readonly required: boolean
  readonly apply: (body: Record<string, unknown>, value: string) => Record<string, unknown>
}

export interface BuiltinServer {
  /** mcp.json 里那个键，同时是会话里工具名的前缀。 */
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly group: string
  readonly homepage: string
  readonly transport: BuiltinTransport
  /** 跑起来之前用户还得自己补什么。没有就是 undefined。 */
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

/**
 * 写进 mcp.json 的那一条正文。形状与协议侧文档同形：远端一条 url，本地一条 command 加 args。
 *
 * legacy 在这里接原生侧的 `launcher_resolve`（把 npx 换成绝对路径、给 .cmd 垫片加 cmd.exe /c）；
 * 新架构没有这条通道，所以交出去的 command 就是名单里那个逻辑程序名（偏差 22）。
 */
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

/* ── 名单页那些格子：分组与状态在这里算完，界面只负责画 ─────────────────── */

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

export interface RowGroup {
  readonly title: string
  readonly rows: readonly CatalogRow[]
}

/*
 * 判空交给标准库：Array.prototype.join 规定 undefined 与 null 元素渲染成空串，逐个字段
 * 判一遍是在手搓一件已被解决的事。分隔符取换行而不是空串，免得相邻两段拼接处凑出一个
 * 本不存在的匹配。
 */
export function matches(needle: string, ...fields: readonly (string | undefined)[]): boolean {
  return needle === '' || fields.join('\n').toLowerCase().includes(needle.toLowerCase())
}

/* 已装的排最前。sort 自 ES2019 起规范要求稳定，同状态因此保持名单里的次序。 */
function ordered(rows: readonly CatalogRow[]): readonly CatalogRow[] {
  return [...rows].sort((left, right) => rank(left) - rank(right))
}

function rank(row: CatalogRow): number {
  return row.status.kind === 'installed' ? 0 : 1
}

/* 「精选」永远在最前，其余按名字排 —— 组名是开放集合，写死一张全序表就意味着少一格。 */
const FEATURED = '精选'

export function groupRows(rows: readonly CatalogRow[]): readonly RowGroup[] {
  const buckets = new Map<string, CatalogRow[]>()

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
      if (left === FEATURED) {
        return -1
      }
      if (right === FEATURED) {
        return 1
      }

      return left.localeCompare(right)
    })
    .map(([title, bucket]) => ({ title, rows: ordered(bucket) }))
}

/**
 * 内置那份名单的行。「已装」的判据是这台服务器的名字出现在已解析的那张 MCP 表里 ——
 * 那张表是唯一真相，这里只拿名字去对，不另存一份「我们装过什么」。
 */
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
