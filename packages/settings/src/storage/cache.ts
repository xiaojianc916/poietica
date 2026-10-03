import type { StorageReport } from './port'

/*
 * 测量缓存：占用不是一个要盯着看的数，量一次要遍历整棵数据根。
 *
 * 判据只有一条 —— 上一次测量还新鲜就直接交回它，进这一页不再重新数；超过保鲜期、或者
 * 用户点了「重新测量」，才真的再走一趟。清理由宿主顺手回一份新测量，记下来即可。
 *
 * 并发只算一次：这一页装载两次（开发模式的双次挂载）也只数一趟。
 */

/** 一份测量的保鲜期：两小时。 */
export const STORAGE_REPORT_FRESH_MS = 2 * 60 * 60 * 1000

export interface StorageMeasurement {
  /** 有新鲜的一份就交回它，否则量一次。 */
  readonly read: () => Promise<StorageReport>
  /** 无论缓存新旧都量一次。 */
  readonly force: () => Promise<StorageReport>
  /** 宿主清完顺手回的那一份：记下来，别再问一遍。 */
  readonly accept: (report: StorageReport) => StorageReport
}

export function createStorageMeasurement(
  measure: () => Promise<StorageReport>,
  options: { readonly freshMs?: number; readonly now?: () => number } = {},
): StorageMeasurement {
  const freshMs = options.freshMs ?? STORAGE_REPORT_FRESH_MS
  const now = options.now ?? Date.now
  let cached: StorageReport | null = null
  let inFlight: Promise<StorageReport> | null = null

  const force = (): Promise<StorageReport> => {
    if (inFlight !== null) {
      return inFlight
    }

    inFlight = measure().then(
      (report) => {
        cached = report
        inFlight = null

        return report
      },
      (cause: unknown) => {
        /* 失败不留下半份缓存：下一次读照常再试。 */
        inFlight = null

        throw cause
      },
    )

    return inFlight
  }

  return {
    read() {
      return cached !== null && now() - cached.measuredAt < freshMs
        ? Promise.resolve(cached)
        : force()
    },

    force,

    accept(report) {
      cached = report

      return report
    },
  }
}
