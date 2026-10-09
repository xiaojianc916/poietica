import type { Dirent } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DataLayout } from '@poietica/runtime-layout'
import type { StorageEntry, StorageEntryId } from '../contract/entities'

export interface StorageDeps {
  readonly layout: DataLayout
  /** 单次统计最多扫描的文件数，默认 200 000；测试注入小值 */
  readonly maxFiles?: number
  readonly clearDefaultSessionCache: () => Promise<void>
  readonly browserSession: { clearCache(): Promise<void>; clearStorageData(): Promise<void> }
}

export interface StorageService {
  report(): Promise<StorageEntry[]>
  clear(kind: 'cache' | 'logs' | 'browser'): Promise<{ freedBytes: number }>
}

/** 缓存目录名：kernel-cache 与 browser-data 是同一个 session/ 的两种切分 */
const CACHE_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
])

export const STORAGE_LABELS: Readonly<Record<StorageEntryId, string>> = Object.freeze({
  conversations: '对话记录',
  database: '数据库',
  attachments: '附件',
  'omp-other': 'Agent 数据',
  scratch: '临时对话文件夹',
  tools: '内置工具',
  logs: '日志',
  'kernel-cache': '浏览器缓存',
  'browser-data': '内置浏览器数据',
  'kernel-state': '其它浏览器状态',
})

export const STORAGE_CLEANABLE: Readonly<Record<StorageEntryId, 'none' | 'safe' | 'confirm'>> = Object.freeze({
  conversations: 'none',
  database: 'none',
  attachments: 'none',
  'omp-other': 'none',
  scratch: 'none',
  tools: 'none',
  logs: 'safe',
  'kernel-cache': 'safe',
  'browser-data': 'confirm',
  'kernel-state': 'none',
})

const ORDER: readonly StorageEntryId[] = [
  'conversations',
  'database',
  'attachments',
  'omp-other',
  'scratch',
  'tools',
  'logs',
  'kernel-cache',
  'browser-data',
  'kernel-state',
]

export function createStorageService(d: StorageDeps): StorageService {
  const maxFiles = d.maxFiles ?? 200_000
  let scanned = 0

  /** 异步、有上限的递归求和：计数器超过 maxFiles 就停止并返回已统计的值 */
  const sizeOf = async (
    dir: string,
    opts: { skip?: (name: string, full: string) => boolean } = {},
  ): Promise<number> => {
    if (scanned >= maxFiles) {
      return 0
    }
    let total = 0
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      if (scanned >= maxFiles) {
        return total
      }
      const full = path.join(dir, entry.name)
      if (opts.skip?.(entry.name, full) === true) continue
      if (entry.isDirectory()) {
        total += await sizeOf(full, opts)
        continue
      }
      scanned++
      try {
        total += (await stat(full)).size
      } catch {
        /* 文件在统计过程中被删掉：跳过 */
      }
    }
    return total
  }

  /** 找出 session/ 下所有的缓存目录（含 Partitions/*） */
  const findCacheDirs = async (): Promise<string[]> => {
    const session = d.layout.chromiumSessionDir
    const found: string[] = []
    const scan = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const full = path.join(dir, entry.name)
        if (CACHE_DIRS.has(entry.name)) found.push(full)
        else await scan(full, depth + 1)
      }
    }
    await scan(session, 0)
    return found
  }

  const sessionUsage = async (): Promise<{ cache: number; browser: number; state: number }> => {
    const sessionTotal = await sizeOf(d.layout.chromiumSessionDir)
    const cacheDirs = await findCacheDirs()
    let cache = 0
    for (const dir of cacheDirs) cache += await sizeOf(dir)
    // browser-data = Partitions/* 减去其中的缓存目录；kernel-state = session/ 减去以上两项
    const partitionsDir = path.join(d.layout.chromiumSessionDir, 'Partitions')
    const partitionTotal = await sizeOf(partitionsDir)
    let partitionCache = 0
    for (const dir of cacheDirs) {
      if (dir.startsWith(partitionsDir)) partitionCache += await sizeOf(dir)
    }
    const browser = Math.max(0, partitionTotal - partitionCache)
    const state = Math.max(0, sessionTotal - cache - browser)
    return { cache, browser, state }
  }

  const ompAgentSessions = (): string => path.join(d.layout.ompAgentDir, 'sessions')

  const report = async (): Promise<StorageEntry[]> => {
    scanned = 0
    const session = await sessionUsage()
    const ompTotal = await sizeOf(d.layout.ompRoot)
    const sessions = await sizeOf(ompAgentSessions())
    const bytes: Record<StorageEntryId, number> = {
      conversations: sessions,
      database: await sizeOf(d.layout.coreDir),
      attachments: await sizeOf(d.layout.attachmentsDir),
      // omp/ 中除 agent/sessions/ 外的全部，加上 native-home/
      'omp-other': Math.max(0, ompTotal - sessions) + (await sizeOf(d.layout.nativeHomeDir)),
      scratch: await sizeOf(d.layout.scratchDir),
      tools: await sizeOf(d.layout.toolsDir),
      logs: await sizeOf(d.layout.logsDir),
      'kernel-cache': session.cache,
      'browser-data': session.browser,
      'kernel-state': session.state,
    }
    return ORDER.map((id) => ({ id, label: STORAGE_LABELS[id], bytes: bytes[id], cleanable: STORAGE_CLEANABLE[id] }))
  }

  const removeDirContents = async (dir: string, keep: (name: string) => boolean): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (keep(entry.name)) continue
      try {
        await rm(path.join(dir, entry.name), { recursive: true, force: true })
      } catch {
        /* 部分删除失败：freedBytes 用清理前后相减得到，不自己累加 */
      }
    }
  }

  return {
    report,
    async clear(kind) {
      const before = (await report()).reduce((sum, e) => sum + e.bytes, 0)
      if (kind === 'cache') {
        for (const dir of await findCacheDirs()) await removeDirContents(dir, () => false)
        await d.clearDefaultSessionCache()
        await d.browserSession.clearCache()
      } else if (kind === 'logs') {
        // 只删轮转副本（*.log.N），当前的 *.log 保留
        await removeDirContents(d.layout.logsDir, (name) => !/\.log\.\d+$/.test(name))
      } else {
        await d.browserSession.clearStorageData()
      }
      const after = (await report()).reduce((sum, e) => sum + e.bytes, 0)
      return { freedBytes: Math.max(0, before - after) }
    },
  }
}
