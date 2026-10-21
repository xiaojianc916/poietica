import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { invalidate } from '@oh-my-pi/pi-coding-agent/capability/fs'
import type { AgentEngine, EngineSession, EngineSessionEvent } from '@poietica/engine'
import { noopLogger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import { createOmpEngineForTest, type MockEngineHandle } from '../testing'
import { testLayout } from './omp-home'

/*
 * omp 知识 #22：MCP 服务器归工作区，引擎持有、会话借用。
 *
 * 这里用真的 stdio 子进程（bun 跑一个最小 MCP 服务器，每次启动把 pid 记进日志）钉住生命周期：
 * 同一个 cwd 的会话共用一组进程；最后一个会话关掉后宽限期内复用、到期退出；配置变了换一份新的；
 * 引擎关闭时一个不留。改动之前，每开一次会话就把全部服务器重新拉起一遍（切 10 次对话 = 30 次拉起）。
 */

const SERVER = `
const fs = require('node:fs')
const [log, name] = process.argv.slice(2)
fs.appendFileSync(log, name + ' ' + process.pid + '\\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let at
  while ((at = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, at)
    buf = buf.slice(at + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    let result = {}
    if (msg.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name, version: '1' } }
    } else if (msg.method === 'tools/list') {
      result = { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] }
    } else if (msg.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'pong:' + name }] }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 1 << 30)
`

const configFile = path.join(testLayout.ompAgentDir, 'mcp.json')
let dir = ''
let script = ''
let log = ''
let engines: AgentEngine[] = []

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'poietica-mcp-ws-'))
  script = path.join(dir, 'server.cjs')
  fs.writeFileSync(script, SERVER)
})

afterEach(async () => {
  for (const engine of engines) await engine.dispose()
  engines = []
  fs.rmSync(configFile, { force: true })
  invalidate(configFile)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function serverConfig(name: string): Record<string, unknown> {
  return { type: 'stdio', command: process.execPath, args: [script, log, name] }
}

function seed(names: readonly string[]): void {
  log = path.join(dir, `spawns-${String(Date.now())}-${String(Math.random()).slice(2)}.log`)
  fs.mkdirSync(testLayout.ompAgentDir, { recursive: true })
  fs.writeFileSync(
    configFile,
    JSON.stringify({ mcpServers: Object.fromEntries(names.map((n) => [n, serverConfig(n)])) }),
  )
  /* omp 的配置读取走进程级的文件内容缓存（capability/fs），只有经它的 config-writer 写才会失效；测试直接写盘，要自己失效 */
  invalidate(configFile)
}

/** 日志里某台服务器的全部 pid（每次拉起一行） */
function pids(name: string): number[] {
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`${name} `))
    .map((line) => Number(line.split(' ')[1]))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function alive(name: string): number[] {
  return pids(name).filter(isAlive)
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(20)
  }
}

async function engineWith(graceMs: number): Promise<MockEngineHandle> {
  const handle = await createOmpEngineForTest({
    layout: testLayout as DataLayout,
    logger: noopLogger,
    relayPort: 0,
    mcpIdleGraceMs: graceMs,
  })
  handle.engine.freezeTools()
  engines.push(handle.engine)
  return handle
}

function open(engine: AgentEngine, key: string, cwd = testLayout.coreCwd): Promise<EngineSession> {
  return engine.openSession({ key, cwd, sessionFile: null, posture: 'full-access', model: null, thinking: null })
}

async function connected(engine: AgentEngine, names: readonly string[]): Promise<boolean> {
  const rows = await engine.mcp.status()
  return names.every((name) => rows.some((row) => row.name === name && row.state === 'connected'))
}

describe('MCP 归工作区', () => {
  test('同一个 cwd 的两个会话共用一组服务器：每台只拉起一次', async () => {
    seed(['a', 'b'])
    const { engine } = await engineWith(60_000)
    const first = await open(engine, 'k1')
    const second = await open(engine, 'k2')
    await until('a、b 都连上', () => connected(engine, ['a', 'b']))
    expect(pids('a')).toHaveLength(1)
    expect(pids('b')).toHaveLength(1)
    await first.dispose()
    await second.dispose()
    expect(pids('a')).toHaveLength(1)
  }, 30_000)

  test('最后一个会话关掉后：宽限期内再开不重启，到期进程退出、状态清空', async () => {
    seed(['a'])
    const { engine } = await engineWith(500)
    const first = await open(engine, 'k1')
    await until('a 连上', () => connected(engine, ['a']))
    await first.dispose()
    /* 宽限期内：进程还在，状态照报 */
    expect(alive('a')).toHaveLength(1)
    expect(await connected(engine, ['a'])).toBe(true)
    const second = await open(engine, 'k2')
    expect(pids('a')).toHaveLength(1)
    await second.dispose()
    await until('宽限到期后 a 退出', () => alive('a').length === 0)
    await until('状态清空', async () => (await engine.mcp.status()).length === 0)
    expect(pids('a')).toHaveLength(1)
  }, 30_000)

  test('配置变了：新会话换一份新的，旧的等用它的会话关掉再退出', async () => {
    seed(['a'])
    const { engine } = await engineWith(60_000)
    const old = await open(engine, 'k1')
    await until('a 连上', () => connected(engine, ['a']))
    const [oldPid] = pids('a')
    await engine.mcp.upsert({ name: 'b', transport: 'stdio', enabled: true, config: serverConfig('b') })
    /* 旧会话还开着：旧进程不动 */
    expect(alive('a')).toEqual([oldPid as number])
    const fresh = await open(engine, 'k2')
    await until('新的一份 a、b 都拉起', () => pids('a').length === 2 && pids('b').length === 1)
    await old.dispose()
    await until('旧的 a 退出', () => !isAlive(oldPid as number))
    expect(alive('a')).toHaveLength(1)
    expect(alive('b')).toHaveLength(1)
    await fresh.dispose()
  }, 30_000)

  test('不同 cwd 各持一份（roots 与项目级 .mcp.json 都按 cwd）', async () => {
    seed(['a'])
    const { engine } = await engineWith(60_000)
    const other = await mkdtemp(path.join(tmpdir(), 'poietica-mcp-cwd-'))
    try {
      const here = await open(engine, 'k1')
      const there = await open(engine, 'k2', other)
      await until('两个工作区各拉起一份 a', () => pids('a').length === 2)
      await here.dispose()
      await there.dispose()
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  }, 30_000)

  test('引擎关闭：宽限期里的服务器一并退出', async () => {
    seed(['a', 'b'])
    const { engine } = await engineWith(60_000)
    const session = await open(engine, 'k1')
    await until('a、b 都连上', () => connected(engine, ['a', 'b']))
    await session.dispose()
    expect(alive('a')).toHaveLength(1)
    await engine.dispose()
    engines = []
    await until('全部退出', () => alive('a').length === 0 && alive('b').length === 0)
  }, 30_000)

  test('借来的工具首轮就在：冷启动的工作区与复用的工作区都能调到', async () => {
    seed(['a'])
    const handle = await engineWith(60_000)
    for (const key of ['cold', 'warm']) {
      const session = await open(handle.engine, key)
      const events: EngineSessionEvent[] = []
      session.subscribe((event) => events.push(event))
      handle.script([
        [
          { kind: 'tool', name: 'mcp__a_ping', args: {}, result: '' },
          { kind: 'text', text: '好了' },
        ],
      ])
      await session.submit({ text: '问', images: [], files: [], skills: [], deliverAs: 'turn' })
      await until('这一轮收尾', () => events.some((event) => event.type === 'state' && event.state === 'idle'))
      const page = await session.page('main', null)
      const tools = page.items
        .flatMap((item) => (item.kind === 'turn' ? item.steps.flatMap((step) => step.frames) : []))
        .filter((frame) => frame.kind === 'tool')
      expect(tools).toHaveLength(1)
      expect(tools[0]).toMatchObject({ name: 'mcp__a_ping', state: 'done' })
      expect(JSON.stringify(tools[0]?.kind === 'tool' ? tools[0].output : null)).toContain('pong:a')
      await session.dispose()
    }
    expect(pids('a')).toHaveLength(1)
  }, 30_000)
})
