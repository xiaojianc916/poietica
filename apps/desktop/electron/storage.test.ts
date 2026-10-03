import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createStorageCommands, type StorageReport, type StorageSessionPort } from './storage'

/** 造一个字节数确定的文件；父目录按需建。 */
function seed(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x'.repeat(bytes))
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'poietica-storage-'))
}

interface Recorded {
  readonly calls: string[]
  readonly sessions: { readonly app: StorageSessionPort; readonly browser: StorageSessionPort }
}

function recordingSession(name: string, calls: string[]): StorageSessionPort {
  return {
    clearKernelCache: () => {
      calls.push(`${name}:cache`)

      return Promise.resolve()
    },
    clearSiteData: () => {
      calls.push(`${name}:site`)

      return Promise.resolve()
    },
  }
}

function recorded(): Recorded {
  const calls: string[] = []

  return {
    calls,
    sessions: {
      app: recordingSession('app', calls),
      browser: recordingSession('browser', calls),
    },
  }
}

function bytesOf(report: StorageReport, id: string): number {
  return report.entries.find((entry) => entry.id === id)?.bytes ?? -1
}

test('分类占用对得上：内核缓存、浏览器数据、未归类各归各的', async () => {
  const root = scratch()

  try {
    seed(join(root, 'ledger.sqlite3'), 10)
    seed(join(root, 'agents', 'agents.json'), 5)
    seed(join(root, 'cache', 'marketplace.json'), 3)
    seed(join(root, 'notes.txt'), 7)
    seed(join(root, 'session', 'Cache', 'Cache_Data', 'data_0'), 100)
    seed(join(root, 'session', 'Code Cache', 'js', 'f_000001'), 50)
    seed(join(root, 'session', 'Local State'), 20)
    seed(join(root, 'session', 'Partitions', 'poietica-browser', 'Cache', 'f_000002'), 40)
    seed(
      join(root, 'session', 'Partitions', 'poietica-browser', 'Local Storage', 'leveldb', '0'),
      30,
    )

    const { sessions } = recorded()
    const commands = createStorageCommands({ root, sessions })
    const report = (await commands.run('storage_report', null)) as StorageReport

    expect(bytesOf(report, 'ledger')).toBe(10)
    expect(bytesOf(report, 'agents')).toBe(5)
    expect(bytesOf(report, 'native-cache')).toBe(3)
    /* 默认会话的缓存 150 + 内置浏览器分区里的缓存 40。 */
    expect(bytesOf(report, 'kernel-cache')).toBe(190)
    /* 分区里除缓存之外的那些：登录态与本地存储。 */
    expect(bytesOf(report, 'browser-data')).toBe(30)
    expect(bytesOf(report, 'kernel-state')).toBe(20)
    expect(bytesOf(report, 'other')).toBe(7)
    expect(report.totalBytes).toBe(265)
    expect(report.truncated).toBe(false)
    expect(report.entries.length).toBe(13)
    /* 时间是这一份测量的读数，不是界面补的：没有它，缓存的「两小时」就没有判据。 */
    expect(Number.isFinite(report.measuredAt)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('清除缓存两个会话都清；清除浏览器数据只清站点数据', async () => {
  const root = scratch()

  try {
    seed(join(root, 'session', 'Cache', 'Cache_Data', 'data_0'), 100)

    const { calls, sessions } = recorded()
    const commands = createStorageCommands({ root, sessions })

    expect(commands.handles('storage_clear_cache')).toBe(true)
    expect(commands.handles('browser_open_tab')).toBe(false)

    const afterCache = (await commands.run('storage_clear_cache', null)) as StorageReport

    expect(calls).toEqual(['app:cache', 'browser:cache'])
    /* 清完当场重报一次，界面不必自己再问一遍。 */
    expect(afterCache.totalBytes).toBe(100)

    calls.length = 0

    await commands.run('storage_clear_browser_data', null)

    expect(calls).toEqual(['browser:cache', 'browser:site'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('认不出的命令当场抛，不当成没发生', async () => {
  const root = scratch()

  try {
    const commands = createStorageCommands({ root, sessions: recorded().sessions })

    await expect(commands.run('storage_drop_everything', null)).rejects.toThrow('requestInvalid')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
