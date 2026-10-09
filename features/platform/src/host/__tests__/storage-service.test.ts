import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dataLayout } from '@poietica/runtime-layout'
import { tempDir } from '@poietica/test-kit'
import { createStorageService, STORAGE_CLEANABLE, STORAGE_LABELS } from '../storage-service'

const MB = 1024 * 1024

function write(dir: string, name: string, bytes: number): void {
  mkdirSync(dir, { recursive: true })
  // Buffer.alloc 默认是零填充，写大文件很慢；用 writeFileSync 的 size 选项不支持，
  // 这里用 Buffer.allocUnsafe 会留随机数据但长度正确 —— 统计只关心字节数
  writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 0))
}

async function makeTree(): Promise<{
  root: string
  layout: ReturnType<typeof dataLayout>
  service: ReturnType<typeof createStorageService>
  dispose: () => Promise<void>
}> {
  const dir = await tempDir('storage-')
  const layout = dataLayout(dir.path)
  // 按 08 页的布局放入已知大小的文件
  write(path.join(layout.ompAgentDir, 'sessions'), 'x.jsonl', 3 * MB)
  write(layout.ompRoot, 'config.yml', 1 * MB)
  write(layout.nativeHomeDir, 'n.bin', 1 * MB)
  write(layout.coreDir, 'poietica.db', 2 * MB)
  write(layout.attachmentsDir, 'a.bin', 4 * MB)
  write(layout.scratchDir, 's.bin', 1 * MB)
  write(layout.toolsDir, 't.bin', 2 * MB)
  write(layout.logsDir, 'main.log', 1 * MB)
  write(layout.logsDir, 'main.log.1', 2 * MB)
  write(layout.logsDir, 'main.log.2', 3 * MB)
  // session/ 的三项切分
  write(path.join(layout.chromiumSessionDir, 'Cache'), 'c.bin', 5 * MB)
  write(path.join(layout.chromiumSessionDir, 'Partitions', 'p1', 'Cache'), 'pc.bin', 2 * MB)
  write(path.join(layout.chromiumSessionDir, 'Partitions', 'p1'), 'ls.bin', 3 * MB)
  write(layout.chromiumSessionDir, 'other.bin', 1 * MB)
  const service = createStorageService({
    layout,
    clearDefaultSessionCache: async () => undefined,
    browserSession: { clearCache: async () => undefined, clearStorageData: async () => undefined },
  })
  return { root: dir.path, layout, service, dispose: dir.dispose }
}

describe('storage-service', () => {
  test('10 项字节数精确；cleanable 与表一致', async () => {
    const t = await makeTree()
    const entries = await t.service.report()
    const byId = Object.fromEntries(entries.map((e) => [e.id, e.bytes]))
    expect(entries.length).toBe(10)
    expect(byId.conversations).toBe(3 * MB)
    expect(byId.database).toBe(2 * MB)
    expect(byId.attachments).toBe(4 * MB)
    // omp 里除 sessions 外的全部（config.yml 1MB）+ native-home（1MB）
    expect(byId['omp-other']).toBe(2 * MB)
    expect(byId.scratch).toBe(1 * MB)
    expect(byId.tools).toBe(2 * MB)
    expect(byId.logs).toBe(6 * MB)
    expect(byId['kernel-cache']).toBe(7 * MB)
    expect(byId['browser-data']).toBe(3 * MB)
    expect(byId['kernel-state']).toBe(1 * MB)
    for (const e of entries) {
      expect(e.label).toBe(STORAGE_LABELS[e.id])
      expect(e.cleanable).toBe(STORAGE_CLEANABLE[e.id])
    }
    await t.dispose()
  })

  test('session/ 三项之和等于 session/ 总大小', async () => {
    const t = await makeTree()
    const entries = await t.service.report()
    const byId = Object.fromEntries(entries.map((e) => [e.id, e.bytes]))
    const total = 5 * MB + 2 * MB + 3 * MB + 1 * MB
    expect(byId['kernel-cache']! + byId['browser-data']! + byId['kernel-state']!).toBe(total)
    await t.dispose()
  })

  test('maxFiles 上限：放 10 个文件、上限 5 也不抛错', async () => {
    const dir = await tempDir('storage-limit-')
    const layout = dataLayout(dir.path)
    for (let i = 0; i < 10; i++) write(layout.coreDir, `f${i}.bin`, 1 * MB)
    const service = createStorageService({
      layout,
      maxFiles: 5,
      clearDefaultSessionCache: async () => undefined,
      browserSession: { clearCache: async () => undefined, clearStorageData: async () => undefined },
    })
    const entries = await service.report()
    expect(entries.length).toBe(10)
    await dir.dispose()
  })

  test("clear('logs') 只删除 *.log.N，当前 *.log 保留；freedBytes 正确", async () => {
    const t = await makeTree()
    const { freedBytes } = await t.service.clear('logs')
    // 删掉 main.log.1（2MB）与 main.log.2（3MB）
    expect(freedBytes).toBe(5 * MB)
    const after = await t.service.report()
    const logs = after.find((e) => e.id === 'logs')
    expect(logs?.bytes).toBe(1 * MB)
    await t.dispose()
  })

  test("clear('cache') 删除缓存目录并调用两个 clearCache", async () => {
    let defaultCache = 0
    let browserCache = 0
    const dir = await tempDir('storage-cache-')
    const layout = dataLayout(dir.path)
    write(path.join(layout.chromiumSessionDir, 'Cache'), 'c.bin', 5 * MB)
    const service = createStorageService({
      layout,
      clearDefaultSessionCache: async () => {
        defaultCache++
      },
      browserSession: {
        clearCache: async () => {
          browserCache++
        },
        clearStorageData: async () => undefined,
      },
    })
    const { freedBytes } = await service.clear('cache')
    expect(freedBytes).toBe(5 * MB)
    expect(defaultCache).toBe(1)
    expect(browserCache).toBe(1)
    await dir.dispose()
  })

  test("clear('browser') 调用 clearStorageData", async () => {
    let cleared = 0
    const dir = await tempDir('storage-browser-')
    const layout = dataLayout(dir.path)
    const session = path.join(layout.chromiumSessionDir, 'Partitions', 'p1')
    write(session, 'ls.bin', 2 * MB)
    const service = createStorageService({
      layout,
      clearDefaultSessionCache: async () => undefined,
      browserSession: {
        clearCache: async () => undefined,
        clearStorageData: async () => {
          cleared++
        },
      },
    })
    await service.clear('browser')
    expect(cleared).toBe(1)
    await dir.dispose()
  })
})
