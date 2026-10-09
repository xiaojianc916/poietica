import type { ModuleDatabase } from '@poietica/storage-sqlite'

export interface FileRow {
  sha256: string
  size: number
  createdAt: number
}

export interface ItemRow {
  id: string
  sha256: string
  name: string
  mime: string
  kind: 'image' | 'file'
  createdAt: number
  /** 内容的字节数（来自 attachments_files；不在 items 表里，读取时联出来） */
  size: number
}

export interface AttachmentsRepository {
  // files（内容，按 sha256 去重）
  insertFileIfAbsent(row: FileRow): void
  getFile(sha256: string): FileRow | null
  /** 没有任何 item 指向的 files */
  orphanFiles(): string[]
  deleteFile(sha256: string): void

  // items（每次导入一条）
  insertItem(row: ItemRow): void
  getItem(id: string): ItemRow | null
  /** 没有任何引用且创建时间早于 cutoff 的 item id */
  unreferencedItems(cutoff: number): string[]
  deleteItem(id: string): void

  // refs（谁在用）
  retain(ownerKey: string, itemId: string, at: number): void
  releaseOwner(ownerKey: string): void
  countRefs(itemId: string): number
}

interface RawItem {
  id: string
  sha256: string
  name: string
  mime: string
  kind: string
  created_at: number
  size: number
}

const itemOf = (r: RawItem): ItemRow => ({
  id: r.id,
  sha256: r.sha256,
  name: r.name,
  mime: r.mime,
  kind: r.kind as ItemRow['kind'],
  createdAt: r.created_at,
  size: r.size,
})

/** items 与 files 联读：尺寸的唯一定义在 files 上（同一内容只有一个尺寸） */
const ITEM_SELECT = `SELECT i.id, i.sha256, i.name, i.mime, i.kind, i.created_at, f.size
  FROM attachments_items i JOIN attachments_files f ON f.sha256 = i.sha256`

export function createAttachmentsRepository(db: ModuleDatabase): AttachmentsRepository {
  return {
    insertFileIfAbsent(row) {
      db.prepare('INSERT OR IGNORE INTO attachments_files (sha256, size, created_at) VALUES (?, ?, ?)').run(
        row.sha256,
        row.size,
        row.createdAt,
      )
    },
    getFile(sha256) {
      const r = db
        .prepare<{ sha256: string; size: number; created_at: number }>(
          'SELECT sha256, size, created_at FROM attachments_files WHERE sha256 = ?',
        )
        .get(sha256)
      return r === null || r === undefined ? null : { sha256: r.sha256, size: r.size, createdAt: r.created_at }
    },
    orphanFiles() {
      return db
        .prepare<{ sha256: string }>(
          'SELECT f.sha256 FROM attachments_files f WHERE NOT EXISTS (SELECT 1 FROM attachments_items i WHERE i.sha256 = f.sha256)',
        )
        .all()
        .map((r) => r.sha256)
    },
    deleteFile(sha256) {
      db.prepare('DELETE FROM attachments_files WHERE sha256 = ?').run(sha256)
    },
    insertItem(row) {
      db.prepare(
        'INSERT INTO attachments_items (id, sha256, name, mime, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(row.id, row.sha256, row.name, row.mime, row.kind, row.createdAt)
    },
    getItem(id) {
      const r = db.prepare<RawItem>(`${ITEM_SELECT} WHERE i.id = ?`).get(id)
      return r === null || r === undefined ? null : itemOf(r)
    },
    unreferencedItems(cutoff) {
      return db
        .prepare<{ id: string }>(
          'SELECT id FROM attachments_items WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM attachments_refs r WHERE r.item_id = attachments_items.id)',
        )
        .all(cutoff)
        .map((r) => r.id)
    },
    deleteItem(id) {
      db.prepare('DELETE FROM attachments_items WHERE id = ?').run(id)
    },
    retain(ownerKey, itemId, at) {
      db.prepare('INSERT OR IGNORE INTO attachments_refs (owner_key, item_id, created_at) VALUES (?, ?, ?)').run(
        ownerKey,
        itemId,
        at,
      )
    },
    releaseOwner(ownerKey) {
      db.prepare('DELETE FROM attachments_refs WHERE owner_key = ?').run(ownerKey)
    },
    countRefs(itemId) {
      const r = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM attachments_refs WHERE item_id = ?').get(itemId)
      return r?.n ?? 0
    },
  }
}
