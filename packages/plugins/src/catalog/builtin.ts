/*
 * Poietica 自己那份名单。
 *
 * 只放 MCP 服务器，不放插件：插件的形状由 kimi.plugin.json 定义、由上游目录分发，我们
 * 造不出第二份真实存在的条目；而一台 MCP 服务器的配置形状是协议侧公开的（mcpServers
 * 表：远端一条 url，本地一条 command 加 args），任何 MCP 客户端认的都是同一份。
 *
 * 收录判据两条：官方或一方维护，且配置片段原样粘进 mcp.json 就跑得起来。跑之前还要用户
 * 自己补钥匙或路径的，needs 里写出来 —— 装上才发现跑不起来，比不收录更糟。
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

export interface BuiltinServer {
  /** mcp.json 里那个键，同时是会话里工具名的前缀。 */
  readonly id: string
  readonly displayName: string
  readonly description: string
  /** 卡片分组名。与目录条目的 keywords 落在同一条分组管线上。 */
  readonly group: string
  readonly homepage: string
  readonly transport: BuiltinTransport
  /** 跑起来之前用户还得自己补什么。没有就是 undefined。 */
  readonly needs: string | undefined
}

export const BUILTIN_SERVERS: readonly BuiltinServer[] = [
  {
    id: 'context7',
    displayName: 'Context7',
    description: '按库名取回最新的官方文档片段，止住模型对着过时 API 编用法。',
    group: '精选',
    homepage: 'https://context7.com',
    transport: { kind: 'http', url: 'https://mcp.context7.com/mcp' },
    needs: '免费额度可直接用，提高速率上限需在 context7.com 取一把 key。',
  },
  {
    id: 'deepwiki',
    displayName: 'DeepWiki',
    description: '对任意公开 GitHub 仓库提问：读目录、读正文、直接问一句。',
    group: '精选',
    homepage: 'https://deepwiki.com',
    transport: { kind: 'http', url: 'https://mcp.deepwiki.com/mcp' },
    needs: undefined,
  },
  {
    id: 'playwright',
    displayName: 'Playwright',
    description: '用可访问性树而不是截图驱动浏览器：导航、点击、填表、断言。',
    group: '浏览器与自动化',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    transport: { kind: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] },
    needs: '需要本机有 Node 18+，首次运行会下载浏览器内核。',
  },
  {
    id: 'chrome-devtools',
    displayName: 'Chrome DevTools',
    description: '接上 Chrome 调试协议：录性能轨迹、看网络请求、读控制台。',
    group: '浏览器与自动化',
    homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    transport: { kind: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@latest'] },
    needs: '需要本机有 Node 18+ 与一个 Chrome。',
  },
  {
    id: 'github',
    displayName: 'GitHub',
    description: '仓库、议题、拉取请求与代码搜索，官方托管的远端服务器。',
    group: '代码与协作',
    homepage: 'https://github.com/github/github-mcp-server',
    transport: { kind: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    needs: '首次连接要走一次 GitHub 授权，或自备一枚 PAT。',
  },
  {
    id: 'filesystem',
    displayName: 'Filesystem',
    description: '在你圈定的目录里读写文件，越界一律拒绝。',
    group: '本机能力',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    transport: {
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/files'],
    },
    needs: '把最后一段换成你允许它进的目录 —— 不换它进不去任何地方。',
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
  },
]

/*
 * 粘进 mcp.json 就能用的那一段。
 *
 * 序列化交给 JSON.stringify 的第三个参数，缩进两格 —— 与协议侧文档里的示例同形，人对照
 * 的时候不会因为格式差异分神。
 */
export function mcpConfigFragment(server: BuiltinServer): string {
  const { transport } = server

  const body =
    transport.kind === 'http'
      ? { url: transport.url }
      : { command: transport.command, args: [...transport.args] }

  return JSON.stringify({ mcpServers: { [server.id]: body } }, null, 2)
}
