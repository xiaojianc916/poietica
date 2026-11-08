import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { openDatabase } from '@poietica/storage-sqlite'
import { tempDir } from '@poietica/test-kit'
import type { CoreModule, CoreModuleContext } from '../module'
import { memoryLayout } from '../testing/memory-layout'
import { alphaContract, handleAlpha, makeKernel } from './helpers'

/*
 * ADR-004 在内核这一层的四条：迁移前备份（第一次启动不备份）、库比程序新 → 只读打开且写入报 kernel.data_read_only、
 * 迁移失败 → 整批回滚后只读打开、退役模块的表被清掉且 cleanup 只在真的清掉东西的那次跑。
 */
const V1 = { version: 1, name: 'init', sql: 'CREATE TABLE alpha_notes (n INTEGER NOT NULL)' }
const V2 = { version: 2, name: 'add-tag', sql: "ALTER TABLE alpha_notes ADD COLUMN tag TEXT NOT NULL DEFAULT ''" }
const BROKEN = { version: 2, name: 'broken', sql: 'ALTER TABLE alpha_missing ADD COLUMN x TEXT' }

/** alpha 模块：alpha.ping 往库里写一行（只读时这一下必然失败） */
function notesModule(migrations: CoreModule['migrations']): CoreModule {
  return {
    id: 'alpha',
    contract: alphaContract,
    migrations,
    setup: (ctx: CoreModuleContext) => {
      handleAlpha(ctx, ['alpha.ping'])
      const rpc = ctx.rpc as unknown as { handle(name: string, fn: (p: { n: number }) => unknown): void }
      rpc.handle('alpha.ping', ({ n }) => {
        ctx.db.prepare('INSERT INTO alpha_notes (n) VALUES (?)').run(n)
        return { n }
      })
    },
  } as unknown as CoreModule
}

const backupsIn = (root: string): string[] => {
  try {
    return readdirSync(memoryLayout(root).dbBackupsDir)
  } catch {
    return []
  }
}

describe('内核：数据演进（ADR-004）', () => {
  test('第一次启动不备份；有待执行的迁移时先备份再迁移', async () => {
    const dir = await tempDir('kernel-evo-')
    const first = await makeKernel([notesModule([V1])], { databaseFile: 'core.db', dataDir: dir.path })
    expect(first.failed).toBe(false)
    expect(await first.client.call('alpha.ping', { n: 1 })).toEqual({ n: 1 })
    await first.dispose()
    expect(backupsIn(dir.path)).toEqual([])

    const second = await makeKernel([notesModule([V1, V2])], { databaseFile: 'core.db', dataDir: dir.path })
    expect(second.failed).toBe(false)
    expect(await second.client.call('alpha.ping', { n: 2 })).toEqual({ n: 2 })
    await second.dispose()
    const backups = backupsIn(dir.path)
    expect(backups).toHaveLength(1)
    /* 备份是升级前的样子：一行、没有 tag 列 */
    const snap = openDatabase(`${memoryLayout(dir.path).dbBackupsDir}/${backups[0]}`, { readonly: true })
    expect(snap.raw.query('SELECT * FROM alpha_notes').all()).toEqual([{ n: 1 }])
    snap.close()
    await dir.dispose()
  })

  test('库比程序新：只读打开、发 warn 提示；写入以 kernel.data_read_only 失败，读照常', async () => {
    const dir = await tempDir('kernel-evo-')
    const newer = await makeKernel([notesModule([V1, V2])], { databaseFile: 'core.db', dataDir: dir.path })
    await newer.client.call('alpha.ping', { n: 1 })
    await newer.dispose()

    const older = await makeKernel([notesModule([V1])], { databaseFile: 'core.db', dataDir: dir.path })
    expect(older.failed).toBe(false)
    expect(older.notifications('core.notice')).toContainEqual(
      expect.objectContaining({ level: 'warn', data: { dataMode: 'readOnly', reason: 'data_too_new' } }),
    )
    const err = await older.request('alpha.ping', { n: 2 }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'kernel.data_read_only' })
    await older.dispose()
    expect(backupsIn(dir.path)).toEqual([])
    await dir.dispose()
  })

  test('迁移失败：整批回滚、只读打开，库还是升级前的样子', async () => {
    const dir = await tempDir('kernel-evo-')
    const v1 = await makeKernel([notesModule([V1])], { databaseFile: 'core.db', dataDir: dir.path })
    await v1.client.call('alpha.ping', { n: 7 })
    await v1.dispose()

    const broken = await makeKernel([notesModule([V1, BROKEN])], { databaseFile: 'core.db', dataDir: dir.path })
    expect(broken.failed).toBe(false)
    expect(broken.notifications('core.notice')).toContainEqual(
      expect.objectContaining({ data: { dataMode: 'readOnly', reason: 'migration_failed' } }),
    )
    await broken.dispose()

    const db = openDatabase(`${dir.path}/core.db`, { readonly: true })
    expect(db.raw.query("SELECT version FROM kernel_migrations WHERE module = 'alpha'").get()).toEqual({ version: 1 })
    expect(db.raw.query('SELECT n FROM alpha_notes').all()).toEqual([{ n: 7 }])
    db.close()
    await dir.dispose()
  })

  test('退役模块：保留数据与迁移记录，不运行破坏性清理', async () => {
    const dir = await tempDir('kernel-evo-')
    const legacy: CoreModule = {
      id: 'old-feature',
      migrations: [
        {
          version: 1,
          name: 'init',
          sql: "CREATE TABLE old_feature_tokens (t TEXT); INSERT INTO old_feature_tokens VALUES ('secret')",
        },
      ],
      setup: () => undefined,
    }
    const before = await makeKernel([notesModule([V1]), legacy], { databaseFile: 'core.db', dataDir: dir.path })
    await before.dispose()

    let cleanups = 0
    const retiredModules = [{ id: 'old-feature', adr: 'ADR-000', cleanup: async () => void cleanups++ }]
    const after = await makeKernel([notesModule([V1])], { databaseFile: 'core.db', dataDir: dir.path, retiredModules })
    expect(after.failed).toBe(false)
    await after.dispose()
    const again = await makeKernel([notesModule([V1])], { databaseFile: 'core.db', dataDir: dir.path, retiredModules })
    await again.dispose()
    expect(cleanups).toBe(0)

    const db = openDatabase(`${dir.path}/core.db`, { readonly: true })
    const names = (db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    )
    expect(names).toContain('old_feature_tokens')
    expect(db.raw.query("SELECT 1 AS x FROM kernel_migrations WHERE module = 'old-feature'").get()).not.toBeNull()
    db.close()
    await dir.dispose()
  })
})
