import { describe, expect, test } from 'bun:test'
import { linkSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dataLayout } from '@poietica/runtime-layout'
import { tempDir } from '@poietica/test-kit'
import { type ChromiumSessionLike, createStorageService, STORAGE_CLEANABLE, STORAGE_LABELS } from '../storage-service'

const MB = 1024 * 1024
const BROWSER_PARTITION = 'poietica-browser'

function write(dir: string, name: string, bytes: number): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 0))
}

function emptyDir(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) rmSync(path.join(dir, name), { recursive: true, force: true })
}

/** 假 Electron Session：clear* 像 Chromium 一样只清缓存目录里的条目、目录本身留着；调用次数记在 calls 里 */
interface FakeSession extends ChromiumSessionLike {
  clearStorageData(): Promise<void>
  readonly calls: { clearCache: number; clearCodeCaches: number; clearStorageData: number }
  cacheSize: number
}

function fakeSession(storagePath: string | null): FakeSession {
  const s: FakeSession = {
    storagePath,
    calls: { clearCache: 0, clearCodeCaches: 0, clearStorageData: 0 },
    cacheSize: 0,
    async getCacheSize() {
      return s.cacheSize
    },
    async clearCache() {
      s.calls.clearCache++
      s.cacheSize = 0
      if (storagePath !== null) emptyDir(path.join(storagePath, 'Cache'))
    },
    async clearCodeCaches() {
      s.calls.clearCodeCaches++
      if (storagePath !== null) emptyDir(path.join(storagePath, 'Code Cache'))
    },
    async clearStorageData() {
      s.calls.clearStorageData++
      if (storagePath !== null) emptyDir(path.join(storagePath, 'Local Storage'))
    },
  }
  return s
}

async function makeTree(options: { maxFiles?: number } = {}) {
  const dir = await tempDir('storage-')
  const layout = dataLayout(dir.path)
  const browserPath = path.join(layout.chromiumSessionDir, 'Partitions', BROWSER_PARTITION)
  // 聊天：会话文件 3 MB + 一张 1 MB 的图（`<sha>` 与 `<sha>.png` 是同一份字节的硬链接）
  write(path.join(layout.ompAgentDir, 'sessions', '-proj-'), 'x.jsonl', 3 * MB)
  write(layout.ompBlobsDir, 'abc', 1 * MB)
  linkSync(path.join(layout.ompBlobsDir, 'abc'), path.join(layout.ompBlobsDir, 'abc.png'))
  write(layout.ompRoot, 'config.yml', 1 * MB)
  write(layout.nativeHomeDir, 'n.bin', 1 * MB)
  write(layout.coreDir, 'poietica.db', 2 * MB)
  write(layout.attachmentsDir, 'a.bin', 4 * MB)
  write(layout.toolsDir, 't.bin', 2 * MB)
  write(layout.logsDir, 'main.log', 1 * MB)
  write(layout.logsDir, 'main.log.1', 2 * MB)
  write(layout.logsDir, 'main.log.2', 3 * MB)
  // 主窗口会话 = session/ 本身
  write(path.join(layout.chromiumSessionDir, 'Cache', 'Cache_Data'), 'c.bin', 5 * MB)
  write(path.join(layout.chromiumSessionDir, 'Code Cache', 'js'), 'cc.bin', 1 * MB)
  write(path.join(layout.chromiumSessionDir, 'GPUCache'), 'g.bin', 1 * MB)
  write(layout.chromiumSessionDir, 'other.bin', 1 * MB)
  // 内置浏览器分区
  write(path.join(browserPath, 'Cache', 'Cache_Data'), 'pc.bin', 2 * MB)
  write(path.join(browserPath, 'Code Cache', 'wasm'), 'pw.bin', 2 * MB)
  write(path.join(browserPath, 'Local Storage'), 'ls.bin', 3 * MB)
  write(path.join(browserPath, 'GPUCache'), 'pg.bin', 1 * MB)
  // 别的分区：既不归缓存也不归浏览器，记在 kernel-state
  write(path.join(layout.chromiumSessionDir, 'Partitions', 'other'), 'old.bin', 1 * MB)

  const app = fakeSession(layout.chromiumSessionDir)
  const browser = fakeSession(browserPath)
  const service = createStorageService({
    layout,
    appSession: () => app,
    browserSession: () => browser,
    budget: { httpCacheBytes: 4 * MB, codeCacheBytes: 1.5 * MB },
    ...options,
  })
  /** 断言「现在的真实字节」时一律显式 refresh：默认那条路给的是缓存。 */
  const bytesOf = async (): Promise<Record<string, number>> =>
    Object.fromEntries((await service.report({ refresh: true })).entries.map((e) => [e.id, e.bytes]))
  return { layout, app, browser, service, bytesOf, dispose: dir.dispose }
}

describe('storage-service', () => {
  test('9 项字节数精确；cleanable / label 与表一致', async () => {
    const t = await makeTree()
    const entries = (await t.service.report()).entries
    const byId = Object.fromEntries(entries.map((e) => [e.id, e.bytes]))
    expect(entries.length).toBe(9)
    expect(byId.conversations).toBe(4 * MB) // 会话 3 + 图片 1（硬链接只算一次）
    expect(byId.database).toBe(2 * MB)
    expect(byId.attachments).toBe(4 * MB)
    expect(byId['omp-other']).toBe(2 * MB) // config 1 + native-home 1，不含 sessions / blobs
    expect(byId.tools).toBe(2 * MB)
    expect(byId.logs).toBe(6 * MB)
    expect(byId['kernel-cache']).toBe(10 * MB) // 两会话的 Cache + Code Cache
    expect(byId['browser-data']).toBe(4 * MB) // 分区里除缓存外的：Local Storage 3 + GPUCache 1
    expect(byId['kernel-state']).toBe(3 * MB) // 主会话 GPUCache 1 + other 1 + 别的分区 1
    for (const e of entries) {
      expect(e.label).toBe(STORAGE_LABELS[e.id])
      expect(e.cleanable).toBe(STORAGE_CLEANABLE[e.id])
    }
    await t.dispose()
  })

  test('各格互不重叠：session/ 三格之和等于 session/ 的真实大小', async () => {
    const t = await makeTree()
    const byId = await t.bytesOf()
    const sessionDir = 5 + 1 + 1 + 1 + (2 + 2 + 3 + 1) + 1
    expect(byId['kernel-cache']! + byId['browser-data']! + byId['kernel-state']!).toBe(sessionDir * MB)
    await t.dispose()
  })

  test('maxFiles 上限：文件超过上限只返回已统计的值，不抛错', async () => {
    const t = await makeTree({ maxFiles: 3 })
    const entries = (await t.service.report()).entries
    expect(entries.length).toBe(9)
    const total = entries.reduce((sum, e) => sum + e.bytes, 0)
    expect(total).toBeLessThanOrEqual(4 * MB)
    await t.dispose()
  })

  test('第二次进来读的是缓存：目录没变就不再扫，measuredAt 也照旧', async () => {
    const t = await makeTree()
    const first = await t.service.report({ refresh: true })
    expect(first.measuredAt).not.toBeNull()

    // 缓存命中：不重扫，返回同一份读数与同一个测量时刻。
    expect(await t.service.report()).toEqual(first)

    // 新开一个 service（模拟下次启动）读同一份缓存文件：仍然不扫。
    const again = createStorageService({
      layout: t.layout,
      appSession: () => t.app,
      browserSession: () => t.browser,
    })
    expect((await again.report()).measuredAt).toBe(first.measuredAt)
    await t.dispose()
  })

  test('缓存文件没有 → 第一次 report() 自己补一次扫描，并把时刻写下来', async () => {
    const dir = await tempDir('storage-cold-')
    const layout = dataLayout(dir.path)
    write(layout.logsDir, 'main.log', 2 * MB)
    const app = fakeSession(layout.chromiumSessionDir)
    const browser = fakeSession(null)
    const service = createStorageService({
      layout,
      appSession: () => app,
      browserSession: () => browser,
      now: () => 1_700_000_000_000,
    })

    const usage = await service.report()
    expect(usage.measuredAt).toBe(1_700_000_000_000)
    expect(usage.entries.find((e) => e.id === 'logs')?.bytes).toBe(2 * MB)

    /* 回归：量完必须把结果收回内存缓存。旧实现只写文件、不更新 usageLoaded，
     * 「从没量过」于是每次都成立 —— 每切回设置页就重扫一遍，一直卡在「正在测量…」。 */
    write(layout.logsDir, 'main.log.9', 5 * MB)
    expect(await service.report()).toEqual(usage)
    await dir.dispose()
  })

  test('refresh: true 才重扫；并发的两次 refresh 共用同一次扫描', async () => {
    const t = await makeTree()
    const first = await t.service.report({ refresh: true })
    write(t.layout.logsDir, 'main.log.9', 3 * MB)

    // 不 refresh：还是旧读数。
    const stale = await t.service.report()
    expect(stale.entries.find((e) => e.id === 'logs')?.bytes).toBe(first.entries.find((e) => e.id === 'logs')?.bytes)

    const [a, b] = await Promise.all([t.service.report({ refresh: true }), t.service.report({ refresh: true })])
    expect(a).toBe(b)
    expect(a.entries.find((e) => e.id === 'logs')?.bytes).toBe(9 * MB)
    await t.dispose()
  })

  test('并发 report 互不干扰（每次测量独立计数）', async () => {
    const t = await makeTree({ maxFiles: 50 })
    const [a, b] = await Promise.all([t.service.report({ refresh: true }), t.service.report({ refresh: true })])
    expect(a).toEqual(b)
    expect(a.entries.find((e) => e.id === 'conversations')?.bytes).toBe(4 * MB)
    await t.dispose()
  })

  test("clear('logs') 只删除 *.log.N，当前 *.log 保留；freedBytes 正确", async () => {
    const t = await makeTree()
    const { freedBytes } = await t.service.clear('logs')
    expect(freedBytes).toBe(5 * MB)
    expect((await t.bytesOf()).logs).toBe(1 * MB)
    await t.dispose()
  })

  test("clear('cache') 只走 Electron 接口（两会话各 clearCache + clearCodeCaches），不碰别的数据", async () => {
    const t = await makeTree()
    const { freedBytes } = await t.service.clear('cache')
    expect(freedBytes).toBe(10 * MB)
    expect(t.app.calls).toEqual({ clearCache: 1, clearCodeCaches: 1, clearStorageData: 0 })
    expect(t.browser.calls).toEqual({ clearCache: 1, clearCodeCaches: 1, clearStorageData: 0 })
    const after = await t.bytesOf()
    expect(after['kernel-cache']).toBe(0)
    expect(after['browser-data']).toBe(4 * MB)
    expect(after['kernel-state']).toBe(3 * MB)
    await t.dispose()
  })

  test("clear('browser') 调用浏览器分区的 clearStorageData，freedBytes 来自前后相减", async () => {
    const t = await makeTree()
    const { freedBytes } = await t.service.clear('browser')
    expect(t.browser.calls.clearStorageData).toBe(1)
    expect(t.app.calls.clearStorageData).toBe(0)
    expect(freedBytes).toBe(3 * MB)
    await t.dispose()
  })

  test('enforceBudgets：只清超出预算的那几份', async () => {
    const t = await makeTree()
    t.app.cacheSize = 6 * MB // > 4 MB × 1.25
    t.browser.cacheSize = 4.5 * MB // 在 1.25 倍容差内
    // 代码缓存预算 1.5 MB：主会话 1 MB 未超，浏览器 2 MB 超
    const trimmed = await t.service.enforceBudgets()
    expect([...trimmed].sort()).toEqual(['app:http', 'browser:code'])
    expect(t.app.calls).toEqual({ clearCache: 1, clearCodeCaches: 0, clearStorageData: 0 })
    expect(t.browser.calls).toEqual({ clearCache: 0, clearCodeCaches: 1, clearStorageData: 0 })
    expect(await t.service.enforceBudgets()).toEqual([])
    await t.dispose()
  })

  test('内存会话（storagePath 为 null）不计目录、不量代码缓存', async () => {
    const dir = await tempDir('storage-mem-')
    const layout = dataLayout(dir.path)
    write(path.join(layout.chromiumSessionDir, 'Cache'), 'c.bin', 1 * MB)
    const app = fakeSession(layout.chromiumSessionDir)
    const browser = fakeSession(null)
    const service = createStorageService({ layout, appSession: () => app, browserSession: () => browser })
    const byId = Object.fromEntries((await service.report({ refresh: true })).entries.map((e) => [e.id, e.bytes]))
    expect(byId['kernel-cache']).toBe(1 * MB)
    expect(byId['browser-data']).toBe(0)
    expect(await service.enforceBudgets()).toEqual([])
    await dir.dispose()
  })
})
