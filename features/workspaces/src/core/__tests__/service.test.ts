import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { ensureDir } from '@poietica/fs-kit'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger, fakeClock, tempDir } from '@poietica/test-kit'
import { type WorkspaceRemoved, workspaceRemoved } from '../../core-api'
import { migrations } from '../migrations'
import { createWorkspacesRepository } from '../repository'
import { createWorkspacesService } from '../service'

async function make() {
  const db = openDatabase(':memory:')
  for (const m of migrations) db.forModule('workspaces').exec(m.sql!)
  const clock = fakeClock()
  const root = await tempDir('ws-')
  const scratchDir = path.join(root.path, 'scratch')
  const changed: number[] = []
  const removed: WorkspaceRemoved[] = []
  const service = createWorkspacesService({
    repo: createWorkspacesRepository(db.forModule('workspaces')),
    scratchDir,
    clock,
    logger: createTestLogger(),
    emitChanged: () => {
      changed.push(1)
    },
    emitRemoved: (e) => {
      removed.push(e)
    },
    fs: {
      isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
      mkdir: (p) => ensureDir(p),
      exists: (p) => fs.existsSync(p),
    },
  })
  return { service, clock, root, scratchDir, changed, removed, db }
}

describe('workspaces 服务（07 页 §3G）', () => {
  test('同一目录以不同大小写 add 两次 → 返回同一 id，last_opened_at 被更新', async () => {
    const { service, clock, root, db } = await make()
    const dir = path.join(root.path, 'Proj')
    await ensureDir(dir)
    const a = service.add(dir)
    clock.advance(1000)
    const b = service.add(dir.toUpperCase())
    expect(b.id).toBe(a.id)
    expect(b.lastOpenedAt).toBeGreaterThan(a.lastOpenedAt)
    expect(service.list().length).toBe(1)
    db.close()
    await root.dispose()
  })

  test('add 一个文件路径 → workspaces.not_a_directory', async () => {
    const { service, root, db } = await make()
    const file = path.join(root.path, 'a.txt')
    fs.writeFileSync(file, 'x')
    const err = (() => {
      try {
        service.add(file)
        return null
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('workspaces.not_a_directory')
    db.close()
    await root.dispose()
  })

  test('add 一个不存在的路径 → not_a_directory', async () => {
    const { service, root, db } = await make()
    const err = (() => {
      try {
        service.add(path.join(root.path, 'nope'))
        return null
      } catch (e) {
        return e
      }
    })()
    expect((err as AppError).code).toBe('workspaces.not_a_directory')
    db.close()
    await root.dispose()
  })

  test('createScratch 建目录、name 是“临时对话”、kind 是 scratch', async () => {
    const { service, root, db } = await make()
    const ws = await service.createScratch()
    expect(ws.kind).toBe('scratch')
    expect(ws.name).toBe('临时对话')
    expect(fs.existsSync(ws.path)).toBe(true)
    expect(ws.exists).toBe(true)
    db.close()
    await root.dispose()
  })

  test('移除 scratch → 目录被删除；workspaceRemoved.kind === scratch', async () => {
    const { service, removed, root, db } = await make()
    const ws = await service.createScratch()
    expect(fs.existsSync(ws.path)).toBe(true)
    await service.remove(ws.id)
    expect(fs.existsSync(ws.path)).toBe(false)
    expect(removed).toEqual([{ workspaceId: ws.id, kind: 'scratch', path: ws.path }])
    expect(service.get(ws.id)).toBeNull()
    db.close()
    await root.dispose()
  })

  test('移除 folder → 目录与其中文件都还在', async () => {
    const { service, removed, root, db } = await make()
    const dir = path.join(root.path, 'keep')
    await ensureDir(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'important')
    const ws = service.add(dir)
    await service.remove(ws.id)
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8')).toBe('important')
    expect(removed[0]!.kind).toBe('folder')
    db.close()
    await root.dispose()
  })

  test('事件在删行之后发：监听器里 get(id) 返回 null', async () => {
    const { service, root, db } = await make()
    let seen: unknown = 'unset'
    const dir = path.join(root.path, 'x')
    await ensureDir(dir)
    const ws = service.add(dir)
    // 用 emitRemoved 的时机断言：删行之后才发
    const removedCb = (e: WorkspaceRemoved): void => {
      seen = service.get(e.workspaceId)
    }
    void removedCb
    // 直接复用服务的 emitRemoved 通道：换一个只在删行后读的探针
    const probe = createWorkspacesService({
      repo: createWorkspacesRepository(db.forModule('workspaces')),
      scratchDir: path.join(root.path, 'scratch'),
      clock: fakeClock(),
      logger: createTestLogger(),
      emitChanged: () => undefined,
      emitRemoved: (e) => {
        seen = service.get(e.workspaceId)
      },
      fs: {
        isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
        mkdir: (p) => ensureDir(p),
        exists: (p) => fs.existsSync(p),
      },
    })
    await probe.remove(ws.id)
    expect(seen).toBeNull()
    db.close()
    await root.dispose()
  })

  test('requireUsable 一个目录已被删掉的工作区 → workspaces.directory_missing', async () => {
    const { service, root, db } = await make()
    const dir = path.join(root.path, 'temp')
    await ensureDir(dir)
    const ws = service.add(dir)
    fs.rmdirSync(dir)
    const err = (() => {
      try {
        service.requireUsable(ws.id)
        return null
      } catch (e) {
        return e
      }
    })()
    expect((err as AppError).code).toBe('workspaces.directory_missing')
    db.close()
    await root.dispose()
  })

  test('requireUsable 不存在的工作区 → workspaces.not_found', async () => {
    const { service, root, db } = await make()
    const err = (() => {
      try {
        service.requireUsable('nope')
        return null
      } catch (e) {
        return e
      }
    })()
    expect((err as AppError).code).toBe('workspaces.not_found')
    db.close()
    await root.dispose()
  })

  test('list 按 last_opened_at DESC；touch 不发通知', async () => {
    const { service, clock, root, changed, db } = await make()
    const a = path.join(root.path, 'a')
    const b = path.join(root.path, 'b')
    await ensureDir(a)
    await ensureDir(b)
    const wa = service.add(a)
    clock.advance(10)
    const wb = service.add(b)
    expect(service.list().map((x) => x.id)).toEqual([wb.id, wa.id])
    const before = changed.length
    clock.advance(10)
    service.touch(wa.id)
    expect(changed.length).toBe(before)
    expect(service.list()[0]!.id).toBe(wa.id)
    db.close()
    await root.dispose()
  })

  test('rename 去掉首尾空白；空名字被拒', async () => {
    const { service, root, db } = await make()
    const dir = path.join(root.path, 'r')
    await ensureDir(dir)
    const ws = service.add(dir)
    expect(service.rename(ws.id, '  新名字  ').name).toBe('新名字')
    const err = (() => {
      try {
        service.rename(ws.id, '   ')
        return null
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(AppError)
    /* 07 页 §3C：空名是入参不合法（kernel.invalid_params），不是「工作区不存在」 */
    expect((err as AppError).code).toBe('kernel.invalid_params')
    db.close()
    await root.dispose()
  })

  test('list 的 exists 实时反映目录状态', async () => {
    const { service, root, db } = await make()
    const dir = path.join(root.path, 'live')
    await ensureDir(dir)
    service.add(dir)
    expect(service.list()[0]!.exists).toBe(true)
    fs.rmdirSync(dir)
    expect(service.list()[0]!.exists).toBe(false)
    db.close()
    await root.dispose()
  })
})

describe('workspaceRemoved 事件令牌', () => {
  test('ownerModule 与 name 与 07 页 §3C 一致', () => {
    expect(workspaceRemoved.ownerModule).toBe('workspaces')
    expect(workspaceRemoved.name).toBe('workspaceRemoved')
  })
})
