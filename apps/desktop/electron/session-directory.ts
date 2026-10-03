/*
 * 内核那摊子从数据根里分出去：<数据根>/session（Electron 的 sessionData）。
 *
 * Chromium 的缓存、代码缓存与分区存储不是我们的数据，寿命与体积也不归我们管；混在数据根
 * 里有两件事永远说不清 —— 这个应用占了多大地方，以及「清理」该清哪一处。分开之后数据根
 * 只剩账本、设置、附件与工具，内核那一摊在一处，一眼可见、一处可清（设置页「存储」）。
 *
 * 必须在 app ready 之前同步做完：Chromium 一旦开始写盘，再搬就是在动它正开着的文件。
 * 实测（Electron 44.5.1）：Cache / Code Cache / GPUCache / Partition 存储都跟着 sessionData 走。
 *
 * 一次性迁移：老版本把这些直接写在数据根里，这一版第一次启动搬进来。清单是实测出来的
 * 布局，漏掉的名字不搬也不删 —— 它只是继续留在数据根里，照常显示为「其他」。等不再有人
 * 从 0.4.3 升上来，这份清单与本函数一起删。
 *
 * Windows 上 'Cache' 与原生侧的 cache/ 是同一个目录（大小写不敏感，paths.rs 的
 * CACHE_DIRECTORY 正是小写），所以这一步会把原生那份可重取的缓存一起带走：它下次用到时
 * 自己重建，代价只是重取一次目录清单。
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const SESSION_DIRECTORY = 'session'

/** 能从上游重取的：清掉只有下次慢一点。设置页那格「清除内核缓存」清的就是这些。 */
export const KERNEL_CACHE_ENTRIES: readonly string[] = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
]

/** 内核与站点的状态：登录态、偏好、网络状态在里面，删了要重新登录或重新配置。 */
export const KERNEL_STATE_ENTRIES: readonly string[] = [
  'Partitions',
  'Network',
  'Local State',
  'Preferences',
  'DIPS',
  'WebStorage',
  'Session Storage',
  'Local Storage',
  'IndexedDB',
  'blob_storage',
  'shared_proto_db',
  'VideoDecodeStats',
  'declarative_performance_observer.db',
]

/**
 * 建好 <数据根>/session，把还留在数据根里的内核条目搬进去，交回 sessionData 的落点。
 *
 * 冲突一律让 session 里的那份赢：它是这一版正在写的，数据根里的是上一版留下的。
 */
export function installSessionDirectory(root: string): string {
  const session = join(root, SESSION_DIRECTORY)

  mkdirSync(session, { recursive: true })

  for (const name of [...KERNEL_CACHE_ENTRIES, ...KERNEL_STATE_ENTRIES]) {
    const source = join(root, name)
    const target = join(session, name)

    if (!existsSync(source) || existsSync(target)) {
      continue
    }

    try {
      renameSync(source, target)
    } catch (cause) {
      /* 搬不动就留在原地：它照常能用，只是这一版还显示在数据根里。 */
      console.warn('内核状态没有搬进 session 目录', name, cause)
    }
  }

  return session
}
