/*
 * 存储这一格：数据根里有什么、各占多少，以及两条清理命令。
 *
 * 与 update_* 同类：命令名进主进程自己的表，不进 Rust 的命令清单 —— 缓存与分区存储是
 * Electron 的能力，原生侧没有它们。
 *
 * 清理只开两个口，判据是「丢掉之后人会不会少东西」：
 *   safe    内核能从上游重取（HTTP 缓存、代码缓存、着色器缓存）
 *   confirm 站点数据（cookies / localStorage / IndexedDB），清完要重新登录
 * 账本、附件、agent 配置、插件只报占用、不开入口 —— 不能清的东西就让它可见。
 *
 * 测量是主动的一次遍历（面板打开时问一次），没有后台扫描、没有上报：这是台本地应用，
 * 占用是给用这台机器的人看的，不是给远端看的。
 */
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { KERNEL_CACHE_ENTRIES, SESSION_DIRECTORY } from './session-directory'

export type StorageCleanability = 'none' | 'safe' | 'confirm'

export interface StorageEntry {
  readonly id: string
  readonly bytes: number
  readonly cleanable: StorageCleanability
}

export interface StorageReport {
  readonly totalBytes: number
  readonly entries: readonly StorageEntry[]
  /** 扫过的文件数。truncated 为真时字节数是「至少这么多」，不假装精确。 */
  readonly scannedFiles: number
  readonly truncated: boolean
  /** 数完这一刻（Date.now()）：界面照它说「上次测量」，那边的缓存照它判新旧。 */
  readonly measuredAt: number
}

/** 会话端口：只声明用得上的两条，测试因此不必认识 electron。 */
export interface StorageSessionPort {
  /** Chromium 的「缓存与文件」：HTTP 磁盘缓存、代码缓存、着色器缓存。 */
  readonly clearKernelCache: () => Promise<void>
  /** 站点数据：cookies、localStorage、IndexedDB。 */
  readonly clearSiteData: () => Promise<void>
}

export interface StorageCommands {
  readonly handles: (command: unknown) => boolean
  readonly run: (command: string, args: unknown) => Promise<unknown>
}

const STORAGE_COMMANDS: readonly string[] = [
  'storage_report',
  'storage_clear_cache',
  'storage_clear_browser_data',
]

/*
 * 数据根里我们认得的条目。名字的正本在 apps/desktop/native/src/paths.rs（原生侧写什么）
 * 与 electron/data-root.ts（从老位置搬什么），这里只是它们的读者。
 */
const DATA_ENTRIES: readonly {
  readonly id: string
  readonly cleanable: StorageCleanability
  readonly names: readonly string[]
}[] = [
  {
    id: 'ledger',
    cleanable: 'none',
    names: ['ledger.sqlite3', 'ledger.sqlite3-wal', 'ledger.sqlite3-shm'],
  },
  {
    id: 'settings',
    cleanable: 'none',
    names: ['settings.json', 'agents.json', 'automations.json'],
  },
  { id: 'agents', cleanable: 'none', names: ['agents'] },
  { id: 'attachments', cleanable: 'none', names: ['attachments'] },
  { id: 'plugins', cleanable: 'none', names: ['plugins'] },
  { id: 'workspace', cleanable: 'none', names: ['projectless'] },
  { id: 'tools', cleanable: 'none', names: ['tools'] },
  { id: 'logs', cleanable: 'none', names: ['logs', 'tmp'] },
  { id: 'native-cache', cleanable: 'none', names: ['cache'] },
]

/** 一次测量里所有条目共用的预算：撞上限就停，报 truncated 而不是把主进程拖住。 */
const MAX_FILES = 200_000

export function createStorageCommands(input: {
  readonly root: string
  readonly sessions: { readonly app: StorageSessionPort; readonly browser: StorageSessionPort }
}): StorageCommands {
  const { root, sessions } = input

  const report = async (): Promise<StorageReport> => {
    const budget: Budget = { files: 0, truncated: false }
    const rows: StorageEntry[] = []
    const session = join(root, SESSION_DIRECTORY)

    for (const entry of DATA_ENTRIES) {
      rows.push({
        id: entry.id,
        bytes: await sumOf(
          entry.names.map((name) => join(root, name)),
          budget,
        ),
        cleanable: entry.cleanable,
      })
    }

    /* 分区目录（内置浏览器的 persist:poietica-browser）里也各有一份内核缓存。 */
    const partitions = await partitionDirectories(session)
    const sessionCache = await sumOf(
      KERNEL_CACHE_ENTRIES.map((name) => join(session, name)),
      budget,
    )
    const partitionCache = await sumOf(
      partitions.flatMap((partition) => KERNEL_CACHE_ENTRIES.map((name) => join(partition, name))),
      budget,
    )
    const partitionTotal = await sumOf(partitions, budget)
    const sessionTotal = await sumOf([session], budget)

    rows.push({ id: 'kernel-cache', bytes: sessionCache + partitionCache, cleanable: 'safe' })
    rows.push({
      id: 'browser-data',
      bytes: Math.max(0, partitionTotal - partitionCache),
      cleanable: 'confirm',
    })
    rows.push({
      id: 'kernel-state',
      bytes: Math.max(0, sessionTotal - sessionCache - partitionTotal),
      cleanable: 'none',
    })

    const totalBytes = await sumOf([root], budget)

    rows.push({
      id: 'other',
      bytes: Math.max(0, totalBytes - rows.reduce((sum, row) => sum + row.bytes, 0)),
      cleanable: 'none',
    })

    return {
      totalBytes,
      entries: rows,
      scannedFiles: budget.files,
      truncated: budget.truncated,
      measuredAt: Date.now(),
    }
  }

  return {
    handles(command) {
      return typeof command === 'string' && STORAGE_COMMANDS.includes(command)
    },

    async run(command) {
      switch (command) {
        case 'storage_report':
          return report()

        /* 两个会话都清：主界面那个默认会话也有 HTTP 缓存，不清就等于留了一半。 */
        case 'storage_clear_cache':
          await sessions.app.clearKernelCache()
          await sessions.browser.clearKernelCache()

          return report()

        /* 站点数据只有内置浏览器有；顺手把它的缓存也清掉，否则「全部」名不副实。 */
        case 'storage_clear_browser_data':
          await sessions.browser.clearKernelCache()
          await sessions.browser.clearSiteData()

          return report()

        default:
          throw new Error(`poietica: requestInvalid — 不是存储命令：${command}`)
      }
    },
  }
}

interface Budget {
  files: number
  truncated: boolean
}

async function sumOf(paths: readonly string[], budget: Budget): Promise<number> {
  let total = 0

  for (const path of paths) {
    total += await measure(path, budget)
  }

  return total
}

/**
 * 一个文件或一棵子树占多少字节。
 *
 * lstat 而不是 stat：跟着链接走会在自指的目录上转不出来。读不到的条目跳过 ——
 * 内核正在改写的文件读不到不是错误。
 */
async function measure(path: string, budget: Budget): Promise<number> {
  const pending: string[] = [path]
  let total = 0

  while (pending.length > 0) {
    if (budget.files > MAX_FILES) {
      budget.truncated = true

      return total
    }

    const current = pending.pop()

    if (current === undefined) {
      break
    }

    const info = await lstat(current).catch(() => null)

    if (info === null) {
      continue
    }

    if (info.isFile()) {
      budget.files += 1
      total += info.size

      continue
    }

    if (!info.isDirectory()) {
      continue
    }

    try {
      for (const child of await readdir(current)) {
        pending.push(join(current, child))
      }
    } catch {
      // 目录在遍历中途消失：这一层当空的。
    }
  }

  return total
}

async function partitionDirectories(session: string): Promise<string[]> {
  try {
    const children = await readdir(join(session, 'Partitions'), { withFileTypes: true })

    return children
      .filter((child) => child.isDirectory())
      .map((child) => join(session, 'Partitions', child.name))
  } catch {
    // 还没开过内置浏览器：没有分区目录。
    return []
  }
}
