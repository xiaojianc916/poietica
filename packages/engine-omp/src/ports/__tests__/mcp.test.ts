import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AppError, noopLogger } from '@poietica/foundation'
import { testLayout } from '../../__tests__/omp-home'
import type { OmpMcpManager } from '../../omp-context'
import { OmpMcpPort } from '../mcp'

/**
 * 用户级 mcp.json 的位置是 <ompAgentDir>/mcp.json，omp 自己的发现也读同一处
 * （测试进程的 preload（tooling/test/omp-isolation.ts）把 PI_CODING_AGENT_DIR 指到隔离根），所以两边说的是同一个文件。
 */
const configFile = path.join(testLayout.ompAgentDir, 'mcp.json')

afterEach(() => {
  rmSync(configFile, { force: true })
})

function makePort(managers: OmpMcpManager[] = [], onConfigChanged?: () => void): OmpMcpPort {
  return new OmpMcpPort({
    ompAgentDir: testLayout.ompAgentDir,
    managers: () => managers,
    logger: noopLogger,
    ...(onConfigChanged === undefined ? {} : { onConfigChanged }),
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
      config: { command: 'node', args: ['server.js'], timeout: 0 },
    })
    const written = readConfig()
    expect(written.mcpServers?.demo?.command).toBe('node')
    expect(written.mcpServers?.demo?.args).toEqual(['server.js'])
    /* 表单那一格写的是 omp 的 `timeout`（0 = 关闭客户端超时），原样落到盘上。 */
    expect(written.mcpServers?.demo?.timeout).toBe(0)
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

  /* 名字不合 omp 判据时 add/update 抛的是裸 Error，经 toEngineError 只剩英文；这里必须先用 omp 自己的
   * validateServerName 拦下，换成带中文说明的 kernel.invalid_params，且一个字都不写盘。 */
  test('名称不合法：写盘前拦下，kernel.invalid_params，文件未生成', async () => {
    const port = makePort()
    await expect(
      port.upsert({ name: 'foo/bar', transport: 'stdio', enabled: true, config: { command: 'node' } }),
    ).rejects.toMatchObject({ code: 'kernel.invalid_params' })
    expect(() => readConfig()).toThrow()
  })

  test('remove 删掉配置文件里的那一台；删不存在的如实报错', async () => {
    seed({ mcpServers: { demo: { type: 'stdio', command: 'node' } } })
    const port = makePort()
    await port.remove('demo')
    expect(readConfig().mcpServers?.demo).toBeUndefined()
    /* 只钉「抛的是引擎边界的 AppError」：具体码由 toEngineError 按 message 猜，路径里带 3 位数字都会被当成
       upstream（见 errors.ts 的 5\d\d 判据），钉死某一档会随临时目录名翻红。 */
    await expect(port.remove('demo')).rejects.toBeInstanceOf(AppError)
  })

  /* omp 的 MCPManager 没有批量状态接口：按名字逐个问（getAllServerNames + getConnectionStatus）。 */
  test('status 从各工作区的共享 manager 汇总，disconnected 映射成 failed', async () => {
    const manager: OmpMcpManager = {
      getAllServerNames: () => ['alpha', 'beta'],
      getConnectionStatus: (name) => (name === 'alpha' ? 'connected' : 'disconnected'),
      getConnection: (name) => (name === 'alpha' ? { tools: [1, 2, 3] } : undefined),
    }
    const port = makePort([manager])
    expect(await port.status()).toEqual([
      { name: 'alpha', state: 'connected', toolCount: 3, error: null },
      { name: 'beta', state: 'failed', toolCount: 0, error: null },
    ])
  })

  test('同名服务器在多个工作区里：先报的那一份（当前工作区在前）', async () => {
    const current: OmpMcpManager = {
      getAllServerNames: () => ['alpha'],
      getConnectionStatus: () => 'connected',
    }
    const retired: OmpMcpManager = {
      getAllServerNames: () => ['alpha', 'beta'],
      getConnectionStatus: () => 'connecting',
    }
    const rows = await makePort([current, retired]).status()
    expect(rows.map((row) => [row.name, row.state])).toEqual([
      ['alpha', 'connected'],
      ['beta', 'connecting'],
    ])
  })

  /* 配置写完要让持有者知道：不然宽限期里的空闲工作区会带着旧配置一直被复用到期满 */
  test('upsert / remove 写完之后通知配置变了', async () => {
    let changed = 0
    const port = makePort([], () => {
      changed++
    })
    await port.upsert({ name: 'demo', transport: 'stdio', enabled: true, config: { command: 'node' } })
    expect(changed).toBe(1)
    await port.remove('demo')
    expect(changed).toBe(2)
    /* 写失败（名字不合法）不通知 */
    await expect(
      port.upsert({ name: 'foo/bar', transport: 'stdio', enabled: true, config: { command: 'node' } }),
    ).rejects.toMatchObject({ code: 'kernel.invalid_params' })
    expect(changed).toBe(2)
  })

  test('没有工作区就没有状态；onDidChangeStatus 在 refreshStatus 后 fire', async () => {
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
 * catalog：Smithery 于 2026-10-31 关停 API，omp 19 删掉了整块 SDK，端口恒回空数组。
 * 只钉这一个行为；形状映射的测试随目录源一起删了。
 */
describe('McpPort.catalog', () => {
  test('目录源没了：恒回空数组，不抛错', async () => {
    expect(await makePort().catalog('demo')).toEqual([])
  })
})
