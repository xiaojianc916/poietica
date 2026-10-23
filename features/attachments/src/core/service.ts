import { existsSync, statSync } from 'node:fs'
import { copyFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, type Clock, createId, type Logger } from '@poietica/foundation'
import { ensureDir, sha256File } from '@poietica/fs-kit'
import type { Attachment } from '../contract'
import { MAX_ATTACHMENT_BYTES } from '../contract/entities'
import { attachmentsErrors } from '../contract/errors'
import type { DescribedAttachment, ResolvedAttachment } from '../core-api'
import { kindOf, mimeOf } from './mime'
import type { AttachmentsRepository, ItemRow } from './repository'

/** 给「刚导入还没发送」的附件留宽限。 */
export const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000
export const SWEEP_FIRST_DELAY_MS = 60_000
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface AttachmentsServiceDeps {
  readonly repo: AttachmentsRepository
  readonly dir: string
  readonly clock: Clock
  readonly logger: Logger
  readonly removeFile?: (file: string) => Promise<void>
}

export interface AttachmentsApi extends AttachmentsServiceDeps {
  importPaths(paths: readonly string[]): Promise<Attachment[]>
  importData(name: string, mime: string, base64: string): Promise<Attachment>
  get(id: string): Attachment
  resolve(ids: readonly string[]): readonly ResolvedAttachment[]
  describe(ids: readonly string[]): readonly DescribedAttachment[]
  retain(ids: readonly string[], ownerKey: string): void
  releaseOwner(ownerKey: string): void
  replaceOwner(ownerKey: string, ids: readonly string[]): { missing: string[] }
  copyOwner(from: string, to: string): void
  sweep(): Promise<{ items: number; files: number }>
}

export function contentPath(dir: string, sha256: string): string {
  return path.join(dir, sha256.slice(0, 2), sha256)
}

export function previewUrlOf(sha256: string, mime: string, kind: 'image' | 'file'): string | null {
  return kind === 'image' ? `poietica-asset://attachment/${sha256}?mime=${encodeURIComponent(mime)}` : null
}

export function attachmentOf(row: ItemRow): Attachment {
  return {
    id: row.id,
    sha256: row.sha256,
    name: row.name,
    mime: row.mime,
    size: row.size ?? 0,
    kind: row.kind,
    createdAt: row.createdAt,
    previewUrl: previewUrlOf(row.sha256, row.mime, row.kind),
  }
}

export function createAttachmentsService(d: AttachmentsServiceDeps): AttachmentsApi {
  /* 一把异步互斥。sweep 先删 items 行、再 `await rm(文件)`；恰好在这个 await 之间导入同一内容时，store 看到 `existsSync(target)` 为真
   * 就走**去重**分支（只补一行 file / item，不碰盘），随后 sweep 的 rm 把文件删掉 —— 新 item 指向一个不存在的文件，从此永远读不到。
   * 导入是用户操作、sweep 每 6 小时一次，串行化没有任何体感成本。只用 promise 链：上一步失败不能让链子断掉。 */
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }
  const removeFile = d.removeFile ?? ((file: string) => rm(file, { force: true }))
  const sha = (id: string): ItemRow => {
    const row = d.repo.getItem(id)
    if (row === null) {
      throw new AppError(attachmentsErrors.not_found, '附件不存在')
    }
    return row
  }

  const store = async (
    source: { kind: 'file'; path: string } | { kind: 'data'; bytes: Uint8Array },
    sha256: string,
    size: number,
  ): Promise<void> => {
    await ensureDir(d.dir)
    const target = contentPath(d.dir, sha256)
    const now = d.clock.now()
    if (existsSync(target)) {
      d.repo.insertFileIfAbsent({ sha256, size, createdAt: now })
      return
    }
    await ensureDir(path.dirname(target))
    const tmp = `${target}.tmp-${createId()}`
    if (source.kind === 'file') {
      await copyFile(source.path, tmp)
    } else {
      await writeFile(tmp, source.bytes)
    }
    try {
      await rename(tmp, target)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined)
      if (!existsSync(target)) throw e
    }
    d.repo.insertFileIfAbsent({ sha256, size, createdAt: now })
  }

  const record = (sha256: string, size: number, name: string, mime: string): Attachment => {
    const now = d.clock.now()
    const kind = kindOf(mime)
    const row: ItemRow = { id: createId(), sha256, name, mime, kind, createdAt: now, size }
    d.repo.insertItem(row)
    return attachmentOf(row)
  }

  return {
    ...d,
    importPaths(paths) {
      return serial(async () => {
        const out: Attachment[] = []
        for (const p of paths) {
          let size: number
          try {
            const stat = statSync(p)
            if (!stat.isFile()) throw new AppError(attachmentsErrors.unreadable, '不是文件')
            size = stat.size
          } catch (e) {
            throw new AppError(attachmentsErrors.unreadable, `无法读取文件：${p}`, { cause: String(e) })
          }
          // 大小检查在复制之前：stat 一看就知道，不必读完再判断。
          if (size > MAX_ATTACHMENT_BYTES) {
            throw new AppError(attachmentsErrors.too_large, '附件超过 50 MB')
          }
          const sha256 = await sha256File(p)
          await store({ kind: 'file', path: p }, sha256, size)
          const name = path.basename(p)
          out.push(record(sha256, size, name, mimeOf(name)))
        }
        return out
      })
    },
    importData(name, mime, base64) {
      return serial(async () => {
        const estimated = Math.floor((base64.length * 3) / 4)
        if (estimated > MAX_ATTACHMENT_BYTES) {
          throw new AppError(attachmentsErrors.too_large, '附件超过 50 MB')
        }
        let bytes: Uint8Array
        try {
          bytes = Uint8Array.fromBase64(base64)
        } catch (e) {
          throw new AppError(attachmentsErrors.unreadable, '无法解码附件内容', { cause: String(e) })
        }
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          throw new AppError(attachmentsErrors.too_large, '附件超过 50 MB')
        }
        const sha256 = Bun.SHA256.hash(bytes, 'hex')
        await store({ kind: 'data', bytes }, sha256, bytes.byteLength)
        return record(sha256, bytes.byteLength, name, mime === '' ? mimeOf(name) : mime)
      })
    },
    get(id) {
      const row = sha(id)
      const file = d.repo.getFile(row.sha256)
      return attachmentOf({ ...row, size: file?.size ?? 0 })
    },
    resolve(ids) {
      return ids.map((id) => {
        const row = sha(id)
        return {
          id: row.id,
          name: row.name,
          mime: row.mime,
          kind: row.kind,
          path: contentPath(d.dir, row.sha256),
        }
      })
    },
    describe(ids) {
      return ids.map((id) => {
        const row = sha(id)
        const file = d.repo.getFile(row.sha256)
        return {
          id: row.id,
          name: row.name,
          mime: row.mime,
          kind: row.kind,
          size: file?.size ?? 0,
          previewUrl: previewUrlOf(row.sha256, row.mime, row.kind),
        }
      })
    },
    retain(ids, ownerKey) {
      const now = d.clock.now()
      d.repo.transaction(() => {
        for (const id of ids) d.repo.retain(ownerKey, id, now)
      })
    },
    releaseOwner(ownerKey) {
      d.repo.releaseOwner(ownerKey)
    },
    replaceOwner(ownerKey, ids) {
      return d.repo.replaceOwner(ownerKey, ids, d.clock.now())
    },
    copyOwner(from, to) {
      d.repo.copyOwner(from, to, d.clock.now())
    },
    sweep() {
      return serial(async () => {
        const cutoff = d.clock.now() - SWEEP_GRACE_MS
        // 顺序：先删 items 行，再删没有 item 指向的 files 行，最后删磁盘文件。
        // 两步删行收进同一个事务（原先每删一行各自一次提交）；磁盘文件在事务之后删 —— 事务里不能 await。
        const { items, orphans } = d.repo.transaction(() => {
          const ids = d.repo.unreferencedItems(cutoff)
          for (const id of ids) d.repo.deleteItem(id)
          const shas = d.repo.orphanFiles()
          for (const sha256 of shas) d.repo.deleteFile(sha256)
          return { items: ids.length, orphans: shas }
        })
        let files = 0
        for (const sha256 of orphans) {
          files++
          await removeFile(contentPath(d.dir, sha256)).catch((e: unknown) => {
            // 只记 warn：文件可能被杀毒软件占用，下次回收会再试一次。
            d.logger.warn('attachment file remove failed', { sha256, error: String(e) })
          })
        }
        return { items, files }
      })
    },
  }
}
