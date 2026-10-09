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

/** 无引用且创建超过这个时长的 item 才会被回收：给“刚导入还没发送”的附件留宽限（07 页 §4C） */
export const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000
export const SWEEP_FIRST_DELAY_MS = 60_000
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface AttachmentsServiceDeps {
  readonly repo: AttachmentsRepository
  /** layout.attachmentsDir */
  readonly dir: string
  readonly clock: Clock
  readonly logger: Logger
}

export interface AttachmentsApi extends AttachmentsServiceDeps {
  importPaths(paths: readonly string[]): Promise<Attachment[]>
  importData(name: string, mime: string, base64: string): Promise<Attachment>
  get(id: string): Attachment
  /** core-api：给 conversation 用的“附件 id → 本地路径”解析 */
  resolve(ids: readonly string[]): readonly ResolvedAttachment[]
  /** core-api：查询表取提交回显要的那几格（name / kind / size / previewUrl） */
  describe(ids: readonly string[]): readonly DescribedAttachment[]
  retain(ids: readonly string[], ownerKey: string): void
  releaseOwner(ownerKey: string): void
  /** UI 持有的附件（草稿）：把 ownerKey 的引用集合整体替换为 ids，不存在的 id 交回调用方 */
  replaceOwner(ownerKey: string, ids: readonly string[]): { missing: string[] }
  /** 分支对话继承源线程的引用（R-07 §3.3） */
  copyOwner(from: string, to: string): void
  sweep(): Promise<{ items: number; files: number }>
}

/** 内容寻址的目标路径：<attachmentsDir>/<sha256 前两位>/<sha256> */
export function contentPath(dir: string, sha256: string): string {
  return path.join(dir, sha256.slice(0, 2), sha256)
}

/** 图片走自定义协议的预览地址；文件类型为 null（07 页 §4B） */
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
  const sha = (id: string): ItemRow => {
    const row = d.repo.getItem(id)
    if (row === null) {
      throw new AppError(attachmentsErrors.not_found, '附件不存在')
    }
    return row
  }

  /** 内容入库：目标不存在就“临时名 → rename”（同盘原子）；已存在就删临时文件（去重） */
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
      // 目标在这一刻被别的导入抢先创建：删掉临时文件，内容已经在库里了
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
    async importPaths(paths) {
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
        // 大小检查在复制之前（07 页 §4C 坑 1）：stat 一看就知道，不必读完再判断
        if (size > MAX_ATTACHMENT_BYTES) {
          throw new AppError(attachmentsErrors.too_large, '附件超过 50 MB')
        }
        const sha256 = await sha256File(p)
        await store({ kind: 'file', path: p }, sha256, size)
        const name = path.basename(p)
        out.push(record(sha256, size, name, mimeOf(name)))
      }
      return out
    },
    async importData(name, mime, base64) {
      // base64 长度估算先判一次（不要解完再判断）
      const estimated = Math.floor((base64.length * 3) / 4)
      if (estimated > MAX_ATTACHMENT_BYTES) {
        throw new AppError(attachmentsErrors.too_large, '附件超过 50 MB')
      }
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(Buffer.from(base64, 'base64'))
      } catch (e) {
        throw new AppError(attachmentsErrors.unreadable, '无法解码附件内容', { cause: String(e) })
      }
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new AppError(attachmentsErrors.too_large, '附件超过 50 MB')
      }
      const { createHash } = await import('node:crypto')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await store({ kind: 'data', bytes }, sha256, bytes.byteLength)
      return record(sha256, bytes.byteLength, name, mime === '' ? mimeOf(name) : mime)
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
      /* 只查表、不碰盘：提交回显要的是「这条附件长什么样」，不是它的字节。 */
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
      for (const id of ids) d.repo.retain(ownerKey, id, now)
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
    async sweep() {
      const cutoff = d.clock.now() - SWEEP_GRACE_MS
      // 顺序：先删 items 行，再删没有 item 指向的 files 行，最后删磁盘文件（07 页 §4C 坑 6）
      let items = 0
      for (const id of d.repo.unreferencedItems(cutoff)) {
        d.repo.deleteItem(id)
        items++
      }
      let files = 0
      for (const sha256 of d.repo.orphanFiles()) {
        d.repo.deleteFile(sha256)
        files++
        await rm(contentPath(d.dir, sha256), { force: true }).catch((e: unknown) => {
          // 删文件失败只记 warn：文件可能被杀毒软件占用，下次回收会再试一次
          d.logger.warn('attachment file remove failed', { sha256, error: String(e) })
        })
      }
      return { items, files }
    },
  }
}
