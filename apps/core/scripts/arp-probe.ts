/*
 * P3 opt-in 集成探针：Core 以 ARP Runtime 启动，确认模块装配、产品工具注册、ports 初始化都能走完并发出 core.ready。
 * 不打开会话；真实会话路径由 core:runtime-probe 覆盖。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RpcPeer } from '@poietica/rpc'
import { createChildProcessTransport } from '@poietica/rpc/stdio'

const env = { ...process.env }
delete env.POIETICA_RUNTIME_ARP
const root = mkdtempSync(path.join(os.tmpdir(), 'poietica-core-arp-'))
const child = spawn(
  path.resolve('apps/core/dist/poietica-core.exe'),
  ['serve', '--data-root', root, '--log-level', 'error'],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  },
)
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += String(chunk)
  if (stderr.length > 32_000) stderr = stderr.slice(-32_000)
})
let resolveReady: (value: unknown) => void = () => undefined
const ready = new Promise<unknown>((resolve) => {
  resolveReady = resolve
})
const peer = new RpcPeer({
  name: 'core-arp-probe',
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
  onNotification: (method, params) => {
    if (method === 'core.ready') resolveReady(params)
  },
})
const timer = setTimeout(() => {
  console.error('[arp-probe] core.ready 超时')
  console.error(stderr.trim().slice(-4_000))
  process.exit(1)
}, 45_000)
try {
  const payload = await ready
  clearTimeout(timer)
  console.log(`[arp-probe] OK ${JSON.stringify(payload)}`)
  await peer.request('core.shutdown', {}, { timeoutMs: 5_000 }).catch(() => undefined)
} finally {
  clearTimeout(timer)
  peer.dispose()
  child.kill()
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  rmSync(root, { recursive: true, force: true })
}
