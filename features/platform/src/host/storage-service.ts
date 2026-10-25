import type { Dirent } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { type Logger, noopLogger } from '@poietica/foundation'
import { createJsonDocument } from '@poietica/fs-kit'
import { CHROMIUM_CODE_CACHE_BYTES, CHROMIUM_HTTP_CACHE_BYTES, type DataLayout } from '@poietica/runtime-layout'
import { type StorageEntryId, StorageUsage } from '../contract/entities'

/** Electron `Session` 里存储页用得到的那几样（测试注入假的）。 */
export interface ChromiumSessionLike {
  /** 会话数据在磁盘上的目录（Electron 的 `session.storagePath`；内存会话为 null） */
  readonly storagePath: string | null
  /** HTTP 缓存的字节数（Chromium 缓存后端自己的账） */
  getCacheSize(): Promise<number>
  clearCache(): Promise<void>
  clearCodeCaches(options: { urls?: string[] }): Promise<void>
}

export interface StorageDeps {
  readonly layout: DataLayout
  /** 默认 200 000；测试注入小值 */
  readonly maxFiles?: number
  /** 主窗口的 defaultSession（生产里每次取到的都是 Electron 的同一个 Session 对象） */
  readonly appSession: () => ChromiumSessionLike
  readonly browserSession: () => ChromiumSessionLike & { clearStorageData(): Promise<void> }
  /** 默认取 runtime-layout 的 storage-budget；测试注入小值 */
  readonly budget?: { readonly httpCacheBytes: number; readonly codeCacheBytes: number }
  /** 测量结果的落盘位置来自 layout；测试也可以指到临时目录 */
  readonly usageFile?: string
  /** 写日志用（缓存损坏时警告）；测试可以不给 */
  readonly logger?: Logger
  /** 测量时刻，测试注入固定值 */
  readonly now?: () => number
}

export interface StorageService {
  /**
   * 存储占用。默认**读上次测量的缓存**（可能略旧），只有 `refresh: true` 才重新走一遍目录。
   * 页面的「重新测量」是唯一需要全量扫描的入口；清完缓存之后也由它顺手重扫一次。
   */
  report(options?: { readonly refresh?: boolean }): Promise<StorageUsage>
  clear(kind: 'cache' | 'logs' | 'browser'): Promise<{ freedBytes: number }>
  /**
   * 启动后跑一次：哪个会话的 HTTP 缓存 / V8 代码缓存超出预算，就用 Electron 的接口清掉（返回清了哪几份）。
   * HTTP 缓存平时由 `--disk-cache-size` 让 Chromium 自己淘汰，这里只兜住超出预算的那部分；代码缓存没有开关，全靠这一步。
   */
  enforceBudgets(): Promise<readonly string[]>
}

/**
 * 「浏览器缓存」只算 Electron 的接口清得掉的两样：HTTP 缓存（`Cache/`，clearCache）与 V8 代码缓存（`Code Cache/`，
 * clearCodeCaches）。GPU / 着色器缓存（GPUCache、DawnGraphiteCache……）正被 GPU 进程用着、没有运行时清理接口，
 * 由 Chromium 自己限量，记进「浏览器数据」里的其余部分。
 */
const HTTP_CACHE_DIR = 'Cache'
const CODE_CACHE_DIR = 'Code Cache'

/** HTTP 缓存的账与目录大小有出入（索引、预分配）：超出预算四分之一才算真的超 */
const HTTP_OVERSHOOT = 1.25

export const STORAGE_LABELS: Readonly<Record<StorageEntryId, string>> = Object.freeze({
  /* 聊天 = omp 的会话文件 + 会话里的图片（omp 的 blob 目录）：图片是对话内容，跟着对话生、跟着对话回收（Core 的 omp gc）。 */
  conversations: '聊天',
  /* 数据库与 omp 的其余数据（配置、模型目录、历史库）合成一格。 */
  database: 'Agent 数据',
  attachments: '附件',
  'omp-other': 'Agent 数据',
  tools: '内置工具',
  logs: '日志',
  'kernel-cache': '浏览器缓存',
  'browser-data': '浏览器数据',
  'kernel-state': '浏览器数据',
})

export const STORAGE_CLEANABLE: Readonly<Record<StorageEntryId, 'none' | 'safe' | 'confirm'>> = Object.freeze({
  conversations: 'none',
  database: 'none',
  attachments: 'none',
  'omp-other': 'none',
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
  'tools',
  'logs',
  'kernel-cache',
  'browser-data',
  'kernel-state',
]

/**
 * 一次测量的账本。每一格都是**互不重叠**的目录遍历（父目录用 skip 跳过子格），不做「总数减子项」：
 * 硬链接按 (dev, ino) 只记一次 —— omp 给每张图在 blob 目录里留一份带扩展名的硬链接（`<sha>`、`<sha>.png` 是同一份字节），
 * 按路径累加会把图片算成两倍。
 */
interface Scan {
  files: number
  readonly seen: Set<string>
}

function pathKey(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function createStorageService(d: StorageDeps): StorageService {
  const maxFiles = d.maxFiles ?? 200_000
  const budget = d.budget ?? { httpCacheBytes: CHROMIUM_HTTP_CACHE_BYTES, codeCacheBytes: CHROMIUM_CODE_CACHE_BYTES }

  /** 一个文件的字节；同一份硬链接字节在本次测量里只记第一次 */
  const fileBytes = async (scan: Scan, file: string): Promise<number> => {
    scan.files++
    try {
      const info = await stat(file, { bigint: true })
      if (info.nlink > 1n) {
        const id = `${info.dev}:${info.ino}`
        if (scan.seen.has(id)) return 0
        scan.seen.add(id)
      }
      return Number(info.size)
    } catch {
      return 0
    }
  }

  /** 文件数超过 maxFiles 就停，返回已统计的值；skip 里的目录整棵跳过（它们归别的格） */
  const sizeOf = async (scan: Scan, dir: string, skip: ReadonlySet<string> = new Set()): Promise<number> => {
    if (scan.files >= maxFiles || skip.has(pathKey(dir))) return 0
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return 0
    }
    let total = 0
    for (const entry of entries) {
      if (scan.files >= maxFiles) return total
      const full = path.join(dir, entry.name)
      total += entry.isDirectory() ? await sizeOf(scan, full, skip) : await fileBytes(scan, full)
    }
    return total
  }

  const newScan = (): Scan => ({ files: 0, seen: new Set() })

  /** 两个会话各自的缓存目录（storagePath 为 null 的内存会话没有） */
  const cacheDirsOf = (s: ChromiumSessionLike): string[] =>
    s.storagePath === null ? [] : [path.join(s.storagePath, HTTP_CACHE_DIR), path.join(s.storagePath, CODE_CACHE_DIR)]

  const cacheBytes = async (scan: Scan): Promise<number> => {
    let total = 0
    for (const dir of [...cacheDirsOf(d.appSession()), ...cacheDirsOf(d.browserSession())])
      total += await sizeOf(scan, dir)
    return total
  }

  const browserDataBytes = async (scan: Scan): Promise<number> => {
    const browser = d.browserSession()
    if (browser.storagePath === null) return 0
    return await sizeOf(scan, browser.storagePath, new Set(cacheDirsOf(browser).map(pathKey)))
  }

  const usageDoc = createJsonDocument({
    file: d.usageFile ?? d.layout.storageUsageFile,
    schema: StorageUsage,
    defaults: () => ({ entries: [], measuredAt: null }),
    logger: d.logger ?? noopLogger,
  })
  const now = d.now ?? (() => Date.now())
  let usageLoaded: Promise<StorageUsage> | null = null
  let scanning: Promise<StorageUsage> | null = null

  /** 真正走一遍目录。结果同时写进缓存文件：下次打开设置页直接读它，不再等一遍扫描。 */
  const scanAndCache = async (): Promise<StorageUsage> => {
    const scan = newScan()
    const sessionsDir = path.join(d.layout.ompAgentDir, 'sessions')
    const browserPath = d.browserSession().storagePath
    const bytes: Record<StorageEntryId, number> = {
      conversations: (await sizeOf(scan, sessionsDir)) + (await sizeOf(scan, d.layout.ompBlobsDir)),
      database: await sizeOf(scan, d.layout.coreDir),
      attachments: await sizeOf(scan, d.layout.attachmentsDir),
      'omp-other':
        (await sizeOf(scan, d.layout.ompRoot, new Set([pathKey(sessionsDir), pathKey(d.layout.ompBlobsDir)]))) +
        (await sizeOf(scan, d.layout.nativeHomeDir)),
      tools: await sizeOf(scan, d.layout.toolsDir),
      logs: await sizeOf(scan, d.layout.logsDir),
      'kernel-cache': await cacheBytes(scan),
      'browser-data': await browserDataBytes(scan),
      // session/ 里剩下的：主窗口的本地存储、GPU / 着色器缓存、别的分区……
      'kernel-state': await sizeOf(
        scan,
        d.layout.chromiumSessionDir,
        new Set([...cacheDirsOf(d.appSession()), ...(browserPath === null ? [] : [browserPath])].map(pathKey)),
      ),
    }
    const usage: StorageUsage = {
      entries: ORDER.map((id) => ({
        id,
        label: STORAGE_LABELS[id],
        bytes: bytes[id],
        cleanable: STORAGE_CLEANABLE[id],
      })),
      measuredAt: now(),
    }
    await usageDoc.save(usage)
    return usage
  }

  /** 同一时刻只允许一次全量扫描：页面上的「重新测量」与清理后的重扫撞在一起时，共用这一份结果。 */
  const refreshCache = (): Promise<StorageUsage> => {
    scanning ??= scanAndCache().finally(() => {
      scanning = null
    })
    return scanning
  }

  const report = async (options?: { readonly refresh?: boolean }): Promise<StorageUsage> => {
    // 量完必须把结果收回内存缓存：否则「从没量过」这个分支每次都成立，
    // 每进一次设置页就重扫一遍整个数据根（慢到一直在「正在测量…」）。
    const fresh = async (): Promise<StorageUsage> => {
      const scanned = await refreshCache()
      usageLoaded = Promise.resolve(scanned)
      return scanned
    }

    if (options?.refresh === true) return await fresh()
    usageLoaded ??= usageDoc.load()
    const cached = await usageLoaded
    // 真的一次都没量过（首次启动、缓存文件不在）才扫；量过就照旧给缓存，哪怕它稍微旧一点。
    return (cached.measuredAt ?? null) === null ? await fresh() : cached
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
        /* freedBytes 用清理前后相减得到，不自己累加。 */
      }
    }
  }

  /** 清理前后只量受影响的那一格：不必为了一个数字把整个数据根走两遍 */
  const freed = async (measure: (scan: Scan) => Promise<number>, act: () => Promise<void>) => {
    const before = await measure(newScan())
    await act()
    const after = await measure(newScan())
    return { freedBytes: Math.max(0, before - after) }
  }

  return {
    report,
    async clear(kind) {
      if (kind === 'cache') {
        /* 只走 Electron 的接口：缓存后端正开着这些文件，从外面删会删到一半（Windows 上被占用的删不掉）还骗过后端的索引。 */
        return await freed(cacheBytes, async () => {
          for (const s of [d.appSession(), d.browserSession()]) {
            await s.clearCache()
            await s.clearCodeCaches({})
          }
        })
      }
      if (kind === 'logs') {
        // 只删轮转副本（*.log.N），当前的 *.log 保留。
        return await freed(
          (scan) => sizeOf(scan, d.layout.logsDir),
          () => removeDirContents(d.layout.logsDir, (name) => !/\.log\.\d+$/.test(name)),
        )
      }
      return await freed(browserDataBytes, () => d.browserSession().clearStorageData())
    },
    async enforceBudgets() {
      const trimmed: string[] = []
      for (const [name, s] of [
        ['app', d.appSession()],
        ['browser', d.browserSession()],
      ] as const) {
        if ((await s.getCacheSize()) > budget.httpCacheBytes * HTTP_OVERSHOOT) {
          await s.clearCache()
          trimmed.push(`${name}:http`)
        }
        if (s.storagePath === null) continue
        if ((await sizeOf(newScan(), path.join(s.storagePath, CODE_CACHE_DIR))) > budget.codeCacheBytes) {
          await s.clearCodeCaches({})
          trimmed.push(`${name}:code`)
        }
      }
      return trimmed
    },
  }
}
