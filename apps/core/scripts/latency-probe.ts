/*
 * P3b 数据面延迟探针：直接拉起 runtime 模式，握手、开会话，然后量 ARP 往返。
 * 只量控制/数据读路径，不调模型；预算按 p95 判定，避免单次抖动误报。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RpcPeer } from '@poietica/rpc'
import { createChildProcessTransport } from '@poietica/rpc/stdio'

const PAGE_BUDGET_MS = 100
const SNAPSHOT_BUDGET_MS = 100

const exe = path.resolve('apps/core/dist/poietica-runtime.exe')
const root = mkdtempSync(path.join(os.tmpdir(), 'poietica-latency-'))
const cwd = mkdtempSync(path.join(os.tmpdir(), 'poietica-latency-cwd-'))
const child = spawn(exe, ['--data-root', root], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += String(chunk)
  if (stderr.length > 32_000) stderr = stderr.slice(-32_000)
})
const peer = new RpcPeer({
  name: 'latency-probe',
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

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
}

async function measure(label: string, budget: number, call: () => Promise<unknown>): Promise<void> {
  const samples: number[] = []
  for (let i = 0; i < 20; i += 1) {
    const started = performance.now()
    await call()
    samples.push(performance.now() - started)
    await Bun.sleep(5)
  }
  const p50 = percentile(samples, 0.5)
  const p95 = percentile(samples, 0.95)
  const verdict = p95 <= budget ? 'OK' : 'OVER'
  console.log(`[latency] ${label} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms budget=${budget}ms ${verdict}`)
  if (verdict === 'OVER') process.exitCode = 1
}

try {
  await peer.request('runtime.hello', { protocolVersion: 1, coreVersion: 'latency-probe' })
  await peer.request('engine.call', { path: ['freezeTools'], args: [] })
  await peer.request('session.open', {
    key: 'latency-thread',
    cwd,
    sessionFile: null,
    posture: 'auto-edit',
    model: null,
    thinking: null,
  })
  await measure('session.page', PAGE_BUDGET_MS, () =>
    peer.request('session.page', { key: 'latency-thread', agentId: 'main', beforeTurnId: null }),
  )
  await measure('engine.snapshot', SNAPSHOT_BUDGET_MS, () => peer.request('engine.snapshot', {}))
  await peer.request('session.close', { key: 'latency-thread' })
  if (process.exitCode !== 1) console.log('[latency] OK')
} catch (error) {
  console.error('[latency] FAILED')
  console.error(stderr.trim().slice(-4_000))
  throw error
} finally {
  peer.dispose()
  child.kill()
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  rmSync(root, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
