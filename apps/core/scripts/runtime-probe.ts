/*
 * P3 进程边界探针：直接启动 Core 可执行文件的 runtime 模式，走 ARP 握手、开会话、冷读、关会话。
 * 不经过 Core 主进程；用来证明 omp Worker 能在独立进程里被拉起与调用。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { jsonValue, RpcPeer } from '@poietica/rpc'
import { createChildProcessTransport } from '@poietica/rpc/stdio'

const exe = path.resolve('apps/core/dist/poietica-runtime.exe')
const root = mkdtempSync(path.join(os.tmpdir(), 'poietica-runtime-'))
const cwd = mkdtempSync(path.join(os.tmpdir(), 'poietica-runtime-cwd-'))
const child = spawn(exe, ['--data-root', root], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += String(chunk)
  if (stderr.length > 64_000) stderr = stderr.slice(-64_000)
})
const peer = new RpcPeer({
  name: 'runtime-probe',
  transport: createChildProcessTransport(child, { onStray: () => undefined }),
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child() {
      return this
    },
  },
  defaultTimeoutMs: 120_000,
})

try {
  const hello = jsonValue(await peer.request('runtime.hello', { protocolVersion: 1, coreVersion: 'probe' })) as {
    protocolVersion: number
    engineVersion: string
  }
  if (hello.protocolVersion !== 1) throw new Error(`协议版本不一致：${hello.protocolVersion}`)
  await peer.request('engine.call', { path: ['freezeTools'], args: [] })
  const opened = jsonValue(
    await peer.request('session.open', {
      key: 'probe-thread',
      cwd,
      sessionFile: null,
      posture: 'auto-edit',
      model: null,
      thinking: null,
    }),
  ) as { sessionFile: string }
  if (typeof opened.sessionFile !== 'string' || opened.sessionFile === '')
    throw new Error('session.open 没交回会话文件')
  const page = jsonValue(
    await peer.request('session.page', {
      key: 'probe-thread',
      agentId: 'main',
      beforeTurnId: null,
    }),
  ) as { items: unknown[] }
  if (!Array.isArray(page.items) || page.items.length !== 0) throw new Error('新会话时间线不是空页')
  await peer.request('session.close', { key: 'probe-thread' })
  console.log(`[runtime-probe] OK hello=${hello.protocolVersion} engine=${hello.engineVersion}`)
} catch (error) {
  console.error('[runtime-probe] FAILED')
  console.error(stderr.trim().slice(-4_000))
  throw error
} finally {
  peer.dispose()
  child.kill()
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  rmSync(root, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
