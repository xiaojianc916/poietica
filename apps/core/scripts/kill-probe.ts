/*
 * P3 崩溃隔离探针：Core 默认用 ARP Runtime 启动，建线程并打开会话，强杀 runtime 子进程，
 * 等待 Core 自动重启 Worker 并恢复会话，再冷读时间线。验证「杀 Worker 不影响 Core，Thread 可继续」。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { killTree, listProcesses } from '@poietica/process-kit'
import { jsonValue, RpcPeer } from '@poietica/rpc'
import { createChildProcessTransport } from '@poietica/rpc/stdio'

const env = { ...process.env }
delete env.POIETICA_RUNTIME_ARP
const root = mkdtempSync(path.join(os.tmpdir(), 'poietica-kill-'))
const workspacePath = mkdtempSync(path.join(os.tmpdir(), 'poietica-kill-ws-'))
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
  name: 'kill-probe',
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
  console.error('[kill-probe] 超时')
  console.error(stderr.trim().slice(-4_000))
  process.exit(1)
}, 60_000)
try {
  await ready
  const workspace = jsonValue(await peer.request('workspaces.add', { path: workspacePath })) as { id: string }
  const thread = jsonValue(await peer.request('threads.create', { workspaceId: workspace.id })) as { id: string }
  await peer.request('threads.open', { threadId: thread.id })
  const worker = (await listProcesses()).find(
    (process) => process.parentPid === child.pid && process.commandLine.includes(' runtime '),
  )
  if (worker === undefined) throw new Error('找不到 runtime 子进程')
  await killTree(worker.pid)
  let recovered = false
  for (let i = 0; i < 80 && !recovered; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      const page = jsonValue(
        await peer.request('timeline.page', { threadId: thread.id, agentId: 'main', beforeTurnId: null }),
      ) as { items: unknown[] }
      recovered = Array.isArray(page.items)
    } catch {
      // Worker 还在重启
    }
  }
  if (!recovered) throw new Error(`Worker 杀掉后未恢复\n${stderr.trim().slice(-4_000)}`)
  console.log('[kill-probe] OK Core 存活，Thread 已恢复')
} finally {
  clearTimeout(timer)
  peer.dispose()
  child.kill()
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  rmSync(root, { recursive: true, force: true })
  rmSync(workspacePath, { recursive: true, force: true })
}
