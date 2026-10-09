import { randomBytes } from 'node:crypto'
import type { rename as fsRename } from 'node:fs/promises'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

type Rename = typeof fsRename

/** Windows 上「目标被别的进程短暂打开」的三种表现（Defender 扫描、Windows Search） */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** 退避 10→20→40… 的总等待上限；超过就放弃并抛出最后一个错误 */
const RENAME_RETRY_BUDGET_MS = 2_000
const RENAME_RETRY_BASE_MS = 10

export interface RenameRetryOptions {
  /** 测试注入 */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * 带退避的 rename（R-08-12）。
 *
 * 立即返回的失败只有一种：目标目录里的临时文件被别的进程攥着 —— Defender 的实时扫描、
 * Windows Search 的索引器都会短暂打开刚写出来的文件，这时 NTFS 的改名会抛
 * EPERM / EACCES / EBUSY（同一个仓库的并发写测试里也能复现）。从前这种偶发拒绝直接
 * 让这次写入作废（JsonDocument 只记一条 error），偏好 / 草稿 / 窗口状态就悄悄丢了。
 *
 * 退避 10→20→40…，总等待封顶 2 秒；其它错误码（路径不存在、跨卷……）立刻抛出，
 * 不白等。
 */
export async function renameWithRetry(
  renameFile: Rename,
  from: string,
  to: string,
  o: RenameRetryOptions = {},
): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let waited = 0
  let delay = RENAME_RETRY_BASE_MS
  let last: unknown
  for (;;) {
    try {
      await renameFile(from, to)
      return
    } catch (e) {
      last = e
      const code = (e as { code?: unknown } | null)?.code
      if (typeof code !== 'string' || !RETRYABLE_RENAME_CODES.has(code)) throw e
      if (waited >= RENAME_RETRY_BUDGET_MS) throw last
      await sleep(delay)
      waited += delay
      delay *= 2
    }
  }
}

/** 写临时文件 → fsync → 改名覆盖。同一目录内改名在 NTFS 上是原子的 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  o: { readonly rename?: Rename } & RenameRetryOptions = {},
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(o.rename ?? rename, tmp, file, o)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}
