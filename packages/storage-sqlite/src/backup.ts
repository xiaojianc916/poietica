import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Database } from './database'

const BACKUP_PREFIX = 'poietica-'
const BACKUP_SUFFIX = '.pre-migrate.db'

export interface BackupOptions {
  /** 备份目录（DataLayout.dbBackupsDir） */
  readonly dir: string
  /** 写进文件名，方便人认出是哪个版本升级前的库 */
  readonly label: string
  /** 只留最近几份（含这一次） */
  readonly keep: number
  readonly now?: () => number
}

/**
 * 迁移前的在线备份（ADR-004）：`VACUUM INTO` 写出一份一致的、紧凑的副本，WAL 里已提交的内容也在里面。
 * 文件名按时间排序；超出 keep 的旧备份删掉。返回这次备份的路径。
 * 只读库、内存库不备份（调用方判断）。
 */
export function backupDatabase(db: Database, opts: BackupOptions): string {
  mkdirSync(opts.dir, { recursive: true })
  const stamp = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-')
  const safeLabel = opts.label.replace(/[^0-9A-Za-z._-]/g, '_')
  const file = path.join(opts.dir, `${BACKUP_PREFIX}${stamp}-${safeLabel}${BACKUP_SUFFIX}`)
  db.raw.query('VACUUM INTO ?').run(file)
  pruneBackups(opts.dir, opts.keep)
  return file
}

/** 目录里现有的迁移前备份，旧的在前 */
export function listBackups(dir: string): readonly string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith(BACKUP_SUFFIX))
    .sort()
    .map((n) => path.join(dir, n))
}

function pruneBackups(dir: string, keep: number): void {
  const all = listBackups(dir)
  for (const file of all.slice(0, Math.max(0, all.length - Math.max(1, keep)))) {
    rmSync(file, { force: true })
  }
}
