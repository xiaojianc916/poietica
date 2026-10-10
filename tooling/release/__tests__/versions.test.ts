import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/*
 * 15 页 §10.1：版本号的唯一来源是 apps/desktop 的 version，apps/core 必须与它相同，
 * 且必须是合法 semver。这条测试属于 `bun run  all`，版本不一致时 CI 直接失败 ——
 * 没有它，「改了一处忘了另一处」要等安装包装完才被发现。
 */

const ROOT = path.resolve(import.meta.dir, '../../..')
const read = (file: string): { version: string } =>
  JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as { version: string }

const SEMVER = /^\d+\.\d+\.\d+$/

test('apps/desktop 与 apps/core 的 version 相同', () => {
  const desktop = read('apps/desktop/package.json')
  const core = read('apps/core/package.json')
  expect(core.version).toBe(desktop.version)
})

test('version 是合法的 x.y.z semver（不带预发布标签）', () => {
  const desktop = read('apps/desktop/package.json')
  expect(SEMVER.test(desktop.version)).toBe(true)
})

/*
 * 铁律 9 的**唯一例外**：`apps/desktop/package.json` 的 `electron-updater` 必须写字面版本，
 * 不能写 `catalog:` —— electron-builder 直接读这个字段做版本判据，遇到 `catalog:` 会报
 * 「At least electron-updater 4.0.0 is recommended」并中止打包（实测）。
 * 这条测试把例外钉住：字面版本必须与根 catalog 同源，改一处忘另一处就红。
 */
test('apps/desktop 的 electron-updater 是字面版本，且与根 catalog 同源', () => {
  const root = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    workspaces: { catalog: Record<string, string> }
  }
  const desktop = JSON.parse(readFileSync(path.join(ROOT, 'apps/desktop/package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  const literal = desktop.dependencies['electron-updater']
  expect(literal).not.toBe('catalog:')
  expect(literal?.startsWith('^')).toBe(true)
  expect(literal?.slice(1)).toBe(root.workspaces.catalog['electron-updater']?.slice(1))
})
