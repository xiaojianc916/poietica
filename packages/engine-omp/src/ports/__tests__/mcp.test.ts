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
