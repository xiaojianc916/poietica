import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { planSync } from '../refs/sync'
import type { FileMap } from './templates'

export const ROOT = path.resolve(import.meta.dir, '../..')

export function writeFiles(files: FileMap): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ROOT, rel)
    if (existsSync(abs)) throw new Error(`已存在，拒绝覆盖：${rel}`)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/** 生成文件后立刻同步全部 references（含根 tsconfig.json） */
export function syncReferences(): void {
  for (const [file, content] of planSync(ROOT)) writeFileSync(path.join(ROOT, file), content)
}

export function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
