import '../../__tests__/omp-home'

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { noopLogger } from '@poietica/foundation'
import { testLayout } from '../../__tests__/omp-home'
import type { OmpMcpManager, OmpSessionLike } from '../../omp-context'
import { OmpMcpPort } from '../mcp'

/**
 * 用户级 mcp.json 的位置是 <ompAgentDir>/mcp.json，omp 自己的发现也读同一处
 * （测试里 omp-home 把 PI_CODING_AGENT_DIR 指到隔离根），所以两边说的是同一个文件。
 */
const configFile = path.join(testLayout.ompAgentDir, 'mcp.json')

afterEach(() => {
  rmSync(configFile, { force: true })
})

function sessionWith(mcpManager: OmpMcpManager | undefined): OmpSessionLike {
  return { sessionId: 's1', sessionKey: 'k1', mcpManager }
}

function makePort(sessions: OmpSessionLike[] = []): OmpMcpPort {
  return new OmpMcpPort({
    ompAgentDir: testLayout.ompAgentDir,
    sessions: new Set(sessions),
    logger: noopLogger,
  })
}

function seed(config: unknown): void {
  writeFileSync(configFile, JSON.stringify(config), 'utf8')
}

function readConfig(): { mcpServers?: Record<string, Record<string, unknown>>; disabledServers?: string[] } {
  return JSON.parse(readFileSync(configFile, 'utf8')) as {
    mcpServers?: Record<string, Record<string, unknown>>
    disabledServers?: string[]
  }
}

describe('McpPort', () => {
  test('upsert 走 omp 的 config-writer，写进 <ompAgentDir>/mcp.json', async () => {
    const port = makePort()
    await port.upsert({
      name: 'demo',
      transport: 'stdio',
      enabled: true,
      config: { command: 'node', args: ['server.js'] },
    })
    const written = readConfig()
    expect(written.mcpServers?.demo?.command).toBe('node')
    expect(written.mcpServers?.demo?.args).toEqual(['server.js'])
  })

  test('enabled=false 落到 disabledServers；list 的 enabled 跟着变', async () => {
    seed({ mcpServers: { demo: { type: 'stdio', command: 'node' } } })
    const port = makePort()
    const before = (await port.list()).find((row) => row.name === 'demo')
    expect(before?.enabled).toBe(true)
    expect(before?.transport).toBe('stdio')
    await port.upsert({ name: 'demo', transport: 'stdio', enabled: false, config: { command: 'node' } })
    expect(readConfig().disabledServers).toContain('demo')
    const after = (await port.list()).find((row) => row.name === 'demo')
    expect(after?.enabled).toBe(false)
  })

  test('upsert 认得 http / sse 两种传输', async () => {
    const port = makePort()
    await port.upsert({ name: 'remote', transport: 'http', enabled: true, config: { url: 'https://mcp.test' } })
    const rows = await port.list()
    expect(rows.find((row) => row.name === 'remote')).toMatchObject({ transport: 'http', enabled: true })
  })

  test('remove 删掉配置文件里的那一台；删不存在的如实报错', async () => {
    seed({ mcpServers: { demo: { type: 'stdio', command: 'node' } } })
    const port = makePort()
    await port.remove('demo')
    expect(readConfig().mcpServers?.demo).toBeUndefined()
    await expect(port.remove('demo')).rejects.toMatchObject({ code: expect.any(String) })
  })

  /* omp 18.5.0 的 MCPManager 没有批量状态接口：按名字逐个问（getAllServerNames + getConnectionStatus）。 */
  test('status 从活会话的 mcpManager 汇总，disconnected 映射成 failed', async () => {
    const manager: OmpMcpManager = {
      getAllServerNames: () => ['alpha', 'beta'],
      getConnectionStatus: (name) => (name === 'alpha' ? 'connected' : 'disconnected'),
      getConnection: (name) => (name === 'alpha' ? { tools: [1, 2, 3] } : undefined),
    }
    const port = makePort([sessionWith(manager)])
    expect(await port.status()).toEqual([
      { name: 'alpha', state: 'connected', toolCount: 3, error: null },
      { name: 'beta', state: 'failed', toolCount: 0, error: null },
    ])
  })

  test('getServerStatus 存在时优先用它（别的实现可能有）', async () => {
    const manager: OmpMcpManager = {
      getServerStatus: () => [{ name: 'gamma', state: 'connecting', toolCount: 1 }],
      getAllServerNames: () => ['should-not-be-used'],
    }
    const port = makePort([sessionWith(manager)])
    expect(await port.status()).toEqual([{ name: 'gamma', state: 'connecting', toolCount: 1, error: null }])
  })

  test('没有会话就没有状态；onDidChangeStatus 在 refreshStatus 后 fire', async () => {
    const port = makePort()
    let fired: unknown = 'never'
    const sub = port.onDidChangeStatus((rows) => {
      fired = rows
    })
    expect(await port.status()).toEqual([])
    port.refreshStatus()
    await Bun.sleep(0)
    expect(fired).toEqual([])
    sub.dispose()
  })
})

/*
 * catalog 的形状映射。**不真连 registry**：那是第三方服务，进 bun run all 就是给闸门装一个
 * 外部开关。这里截住 fetch，喂一份按真实报文精简过的响应，钉住映射本身。
 */
describe('McpPort.catalog', () => {
  const realFetch = globalThis.fetch

  /* 换掉全局 fetch 要绕开 `typeof fetch` 上的 preconnect 等附加属性：只借用它的调用签名。 */
  function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return Promise.resolve(handler(url))
    }) as unknown as typeof fetch
  }

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** 按真实 /servers 与 /servers/<id> 的形状给两条：一条 remote、一条 stdio 且要密钥。 */
  function stubRegistry(): void {
    /* 列表那一层就带 displayName / qualifiedName：omp 拿它们与关键词做同一性命中
     * （matchesIdentityQuery），不给就会被整个滤掉 —— 这正是真报文的形状。 */
    /* verified / useCount 取自**列表**那一层（omp 的 toSearchResult 读的就是 entry.verified），
     * displayName / qualifiedName 也是 —— 都必须在列表里给全。 */
    const servers = [
      {
        id: 'a/one',
        qualifiedName: '@a/demo-one',
        displayName: 'Demo One',
        namespace: 'a',
        slug: 'demo-one',
        verified: true,
        useCount: 42,
      },
      {
        id: 'b/two',
        qualifiedName: '@b/demo-two',
        displayName: 'Demo Two',
        namespace: 'b',
        slug: 'demo-two',
        verified: false,
        useCount: 5,
      },
    ]
    /* 详情按 `namespace/slug` 取（omp 的 resolveDetailPathCandidates 就是这个顺序），
     * 与列表里的 id 不是一回事 —— 用 slug 当键才是真报文的形状。 */
    const detail: Record<string, unknown> = {
      'a/demo-one': {
        id: 'a/one',
        qualifiedName: '@a/demo-one',
        displayName: 'Demo One',
        description: '第一条',
        verified: true,
        useCount: 42,
        remote: true,
        isDeployed: true,
        tools: [],
        connections: [{ type: 'http', deploymentUrl: 'https://one.test/mcp' }],
      },
      'b/demo-two': {
        id: 'b/two',
        qualifiedName: '@b/demo-two',
        displayName: 'Demo Two',
        description: '第二条',
        verified: false,
        useCount: 5,
        tools: [],
        /* configSchema 挂在 **connection** 上（omp 的 getSchemaInputs 读的就是它）：
         * 放到 details 根上会被忽略，requiredInputs 就是空的。 */
        connections: [
          {
            type: 'stdio',
            runtime: 'node',
            configSchema: {
              type: 'object',
              required: ['apiKey'],
              properties: { apiKey: { type: 'string', description: '密钥' } },
            },
          },
        ],
      },
    }

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url.includes('/servers/')) {
        const id = decodeURIComponent(url.split('/servers/')[1] ?? '').split('?')[0] ?? ''
        return Response.json(detail[id] ?? {})
      }

      return Response.json({ servers })
    }) as unknown as typeof fetch
  }

  test('目录条目映射成契约形状：名字归一、正文可直接写盘、必填输入带出来', async () => {
    stubRegistry()
    /* 关键词要与 displayName / qualifiedName 命得上 —— 真报文的检索就是这个口径。 */
    const entries = await makePort().catalog('demo')

    expect(entries.map((entry) => entry.id)).toEqual(['a/one', 'b/two'])

    const remote = entries[0]
    /* 目录名带斜杠（`a/demo-one`），写盘前必须归一成 validateServerName 认的形状。 */
    expect(remote?.name).toBe('a-demo-one')
    expect(remote?.name).toMatch(/^[a-zA-Z0-9_.:-]+$/)
    expect(remote?.verified).toBe(true)
    expect(remote?.useCount).toBe(42)
    expect(remote?.sourceType).toBe('remote')
    expect(remote?.config).toMatchObject({ type: 'http', url: 'https://one.test/mcp' })

    const local = entries[1]
    expect(local?.sourceType).toBe('package')
    expect(local?.config).toMatchObject({ type: 'stdio' })
    /* 要密钥的那一条必须把「补什么」带出来，否则界面无从提示。 */
    expect(local?.inputs).toEqual([
      {
        key: 'apiKey',
        label: expect.any(String),
        required: true,
        sensitive: true,
        defaultValue: null,
        description: '密钥',
      },
    ])
  })

  test('空关键词不查目录（连 fetch 都不发）', async () => {
    let called = 0
    stubFetch(() => {
      called += 1
      return Response.json({ servers: [] })
    })

    expect(await makePort().catalog('   ')).toEqual([])
    expect(called).toBe(0)
  })

  test('目录方报错时如实抛 AppError，不假装成空结果', async () => {
    stubFetch(() => new Response('boom', { status: 503 }))
    await expect(makePort().catalog('demo')).rejects.toMatchObject({ code: expect.any(String) })
  })
})
