// 用法：bun run schema:snapshot   （发版时跑：把这一版的库结构写进 apps/core/schema/released/v<版本>.json）
//
// 已发布的快照只增不改：同名文件已存在且内容不同就拒绝 —— 那说明有人改了已发布的迁移，
// 正确的做法是追加一条新迁移（ADR-004）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { coreModules } from '../src/modules'
import { buildSchemaSnapshot } from '../src/schema-snapshot'

/** package.json 是外部输入：解析可能抛，缺字段是 undefined，先校验再取。 */
function readVersion(file: string): string {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const version = typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined
  if (typeof version !== 'string' || version.length === 0) throw new Error(`${file} 缺 version`)
  return version
}

const version = readVersion(path.join(import.meta.dir, '..', 'package.json'))
const file = path.join(import.meta.dir, '..', 'schema', 'released', `v${version}.json`)
const text = `${JSON.stringify(buildSchemaSnapshot(version, coreModules), null, 2)}\n`
if (existsSync(file) && readFileSync(file, 'utf8') !== text) {
  process.stderr.write(
    `${path.relative(process.cwd(), file)} 已存在且与当前结构不同：已发布的迁移不能改，请追加新迁移。\n`,
  )
  process.exit(1)
}
writeFileSync(file, text)
process.stdout.write(`已写入 ${path.relative(process.cwd(), file)}\n`)
