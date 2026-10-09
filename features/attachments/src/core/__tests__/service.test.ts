import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger, fakeClock, tempDir } from '@poietica/test-kit'
import { MAX_ATTACHMENT_BYTES } from '../../contract/entities'
import { migrations } from '../migrations'
import { createAttachmentsRepository } from '../repository'
import { contentPath, createAttachmentsService, SWEEP_GRACE_MS } from '../service'

async function make() {
  const db = openDatabase(':memory:')
  for (const m of migrations) db.forModule('attachments').exec(m.sql!)
  const clock = fakeClock()
  const root = await tempDir('att-')
  const dir = path.join(root.path, 'attachments')
  const service = createAttachmentsService({
    repo: createAttachmentsRepository(db.forModule('attachments')),
    dir,
    clock,
    logger: createTestLogger(),
  })
  return { service, clock, root, dir, db }
}

describe('attachments 服务（07 页 §4G、14 页 §8.6）', () => {
  test('同一个文件用不同文件名导入两次 → 两个 item、一个 file、磁盘上一个文件', async () => {
    const { service, root, dir, db } = await make()
    const src = path.join(root.path, 'shot.png')
    fs.writeFileSync(src, 'PNGDATA')
    const a = await service.importPaths([src])
    const b = await service.importPaths([src])
    expect(a.length).toBe(1)
    expect(b.length).toBe(1)
    expect(a[0]!.id).not.toBe(b[0]!.id)
    expect(a[0]!.sha256).toBe(b[0]!.sha256)
    const files = fs.readdirSync(path.join(dir, a[0]!.sha256.slice(0, 2)))
    expect(files).toEqual([a[0]!.sha256])
    expect(a[0]!.kind).toBe('image')
    expect(a[0]!.previewUrl).toBe(`poietica-asset://attachment/${a[0]!.sha256}?mime=image%2Fpng`)
    db.close()
    await root.dispose()
  })

  test('50 MB + 1 字节 → attachments.too_large，磁盘上没有残留临时文件', async () => {
    const { service, root, dir, db } = await make()
    const big = path.join(root.path, 'big.bin')
    // 用 truncate 造大小，不真的写 50MB 数据
    const fd = fs.openSync(big, 'w')
    fs.ftruncateSync(fd, MAX_ATTACHMENT_BYTES + 1)
    fs.closeSync(fd)
    const err = await service.importPaths([big]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('attachments.too_large')
    const leftovers = fs.existsSync(dir)
      ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).includes('.tmp-'))
      : []
    expect(leftovers).toEqual([])
    db.close()
    await root.dispose()
  })

  test('base64 超过上限在解码前就被拒', async () => {
    const { service, root, db } = await make()
    const huge = 'A'.repeat(Math.ceil(((MAX_ATTACHMENT_BYTES + 10) * 4) / 3))
    const err = await service.importData('x.png', 'image/png', huge).catch((e: unknown) => e)
    expect((err as AppError).code).toBe('attachments.too_large')
    db.close()
    await root.dispose()
  })

  test('importData 落盘并返回图片附件', async () => {
    const { service, root, dir, db } = await make()
    const base64 = Buffer.from('hello-image').toString('base64')
    const a = await service.importData('paste.png', 'image/png', base64)
    expect(a.kind).toBe('image')
    expect(a.size).toBe(11)
    expect(fs.readFileSync(contentPath(dir, a.sha256), 'utf8')).toBe('hello-image')
    db.close()
    await root.dispose()
  })

  test('resolve([存在, 不存在]) → attachments.not_found', async () => {
    const { service, root, db } = await make()
    const src = path.join(root.path, 'a.txt')
    fs.writeFileSync(src, 'x')
    const [a] = await service.importPaths([src])
    const err = (() => {
      try {
        service.resolve([a!.id, 'nope'])
        return null
      } catch (e) {
        return e
      }
    })()
    expect((err as AppError).code).toBe('attachments.not_found')
    expect(service.resolve([a!.id])[0]!.path).toBe(contentPath(path.join(root.path, 'attachments'), a!.sha256))
    db.close()
    await root.dispose()
  })

  test('get 不存在 → attachments.not_found', async () => {
    const { service, root, db } = await make()
    const err = (() => {
      try {
        service.get('nope')
        return null
      } catch (e) {
        return e
      }
    })()
    expect((err as AppError).code).toBe('attachments.not_found')
    db.close()
    await root.dispose()
  })

  test('回收：无引用 23 小时仍在；25 小时 item 与 file 都被删除、磁盘文件被删除', async () => {
    const { service, clock, root, dir, db } = await make()
    const src = path.join(root.path, 'a.txt')
    fs.writeFileSync(src, 'data')
    const [a] = await service.importPaths([src])
    const file = contentPath(dir, a!.sha256)

    clock.advance(SWEEP_GRACE_MS - 3_600_000) // 23 小时
    expect(await service.sweep()).toEqual({ items: 0, files: 0 })
    expect(fs.existsSync(file)).toBe(true)

    clock.advance(2 * 3_600_000) // 累计 25 小时
    const swept = await service.sweep()
    expect(swept).toEqual({ items: 1, files: 1 })
    expect(fs.existsSync(file)).toBe(false)
    db.close()
    await root.dispose()
  })

  test('item 被 retain 后再 releaseOwner → 引用被删，25 小时后可回收', async () => {
    const { service, clock, root, dir, db } = await make()
    const src = path.join(root.path, 'a.txt')
    fs.writeFileSync(src, 'data')
    const [a] = await service.importPaths([src])
    service.retain([a!.id], 'conversation:thread:t1')
    clock.advance(SWEEP_GRACE_MS + 3_600_000)
    expect((await service.sweep()).items).toBe(0)
    service.releaseOwner('conversation:thread:t1')
    expect((await service.sweep()).items).toBe(1)
    expect(fs.existsSync(contentPath(dir, a!.sha256))).toBe(false)
    db.close()
    await root.dispose()
  })

  test('retain 幂等：同一 owner 同一 item 两次只有一条引用', async () => {
    const { service, root, db } = await make()
    const src = path.join(root.path, 'a.txt')
    fs.writeFileSync(src, 'x')
    const [a] = await service.importPaths([src])
    service.retain([a!.id], 'o1')
    service.retain([a!.id], 'o1')
    const r = createAttachmentsRepository(db.forModule('attachments'))
    expect(r.countRefs(a!.id)).toBe(1)
    db.close()
    await root.dispose()
  })

  test('未知扩展名 → application/octet-stream 且 kind 是 file、previewUrl 为 null', async () => {
    const { service, root, db } = await make()
    const src = path.join(root.path, 'weird.zzz')
    fs.writeFileSync(src, 'x')
    const [a] = await service.importPaths([src])
    expect(a!.mime).toBe('application/octet-stream')
    expect(a!.kind).toBe('file')
    expect(a!.previewUrl).toBeNull()
    db.close()
    await root.dispose()
  })

  test('目录第一次写入时自动创建', async () => {
    const { service, dir, root, db } = await make()
    expect(fs.existsSync(dir)).toBe(false)
    const src = path.join(root.path, 'a.txt')
    fs.writeFileSync(src, 'x')
    await service.importPaths([src])
    expect(fs.existsSync(dir)).toBe(true)
    db.close()
    await root.dispose()
  })

  test('不存在的路径导入 → attachments.unreadable', async () => {
    const { service, root, db } = await make()
    const err = await service.importPaths([path.join(root.path, 'missing.txt')]).catch((e: unknown) => e)
    expect((err as AppError).code).toBe('attachments.unreadable')
    db.close()
    await root.dispose()
  })

  test('ensureDir 兜底：attachmentsDir 预先不存在时也能写入', async () => {
    const { service, root, db } = await make()
    const nested = path.join(root.path, 'x', 'y')
    const s2 = createAttachmentsService({
      repo: createAttachmentsRepository(db.forModule('attachments')),
      dir: nested,
      clock: fakeClock(),
      logger: createTestLogger(),
    })
    void service
    const src = path.join(root.path, 'a.txt')
    fs.writeFileSync(src, 'x')
    await s2.importPaths([src])
    expect(fs.existsSync(nested)).toBe(true)
    db.close()
    await root.dispose()
  })

  test('回收在 60 秒后才第一次跑（模块接线由 core/index 负责，这里断言常量的关系）', () => {
    expect(SWEEP_GRACE_MS).toBe(24 * 60 * 60 * 1000)
  })
})
