import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { coreModules, retiredCoreModules } from '../modules'
import { buildSchemaSnapshot, byName, type SchemaSnapshot, upgradeSnapshot } from '../schema-snapshot'

/*
 * ADR-004「已发布版本迁移测试」：apps/core/schema/released 下每一份已发布版本的库结构，都必须能被当前代码
 * 原地升级（保留退役数据 → 整批前向迁移），并且活跃模块的结构与全新安装逐条相同。
 * 改了已发布的迁移 → 指纹对不上（SchemaDriftError）；新迁移漏了什么 → 结构对不上。
 */
const releasedDir = path.join(import.meta.dir, '..', '..', 'schema', 'released')
const released = readdirSync(releasedDir).filter((f) => f.endsWith('.json'))

describe('已发布版本的库升级到当前代码（ADR-004）', () => {
  const fresh = byName(buildSchemaSnapshot('current', coreModules).objects)

  test('至少有一份已发布快照（v0.5.20 是基线）', () => {
    expect(released).toContain('v0.5.20.json')
  })

  for (const file of released) {
    test(`${file} → 当前：升级成功，结构与全新安装相同`, () => {
      const snapshot = JSON.parse(readFileSync(path.join(releasedDir, file), 'utf8')) as SchemaSnapshot
      const upgraded = upgradeSnapshot(snapshot, coreModules, retiredCoreModules)
      const active = upgraded.filter(
        (o) => !retiredCoreModules.some((r) => o.name.startsWith(`${r.id.replace(/-/g, '_')}_`)),
      )
      expect(byName(active)).toEqual(fresh)
    })
  }

  test('退役模块的数据保留以避免升级丢失', () => {
    const snapshot = JSON.parse(readFileSync(path.join(releasedDir, 'v0.5.20.json'), 'utf8')) as SchemaSnapshot
    const names = upgradeSnapshot(snapshot, coreModules, retiredCoreModules).map((o) => o.name)
    for (const retired of retiredCoreModules) {
      expect(names.some((n) => n.startsWith(`${retired.id.replace(/-/g, '_')}_`))).toBe(true)
    }
  })
})
