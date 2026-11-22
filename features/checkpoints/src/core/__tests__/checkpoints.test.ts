import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCheckpointService } from '../checkpoints'

const roots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'poietica-checkpoints-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('影子检查点', () => {
  test('shell 造成的改动进入检查点，可 diff、可恢复', async () => {
    const root = await workspace()
    const service = createCheckpointService({ dir: path.join(root, '.shadow') })
    const file = path.join(root, 'a.txt')
    await writeFile(file, 'one')

    const first = await service.create({ workspaceRoot: root, threadId: 't1', label: '轮次开始' })
    await writeFile(file, 'two')
    const second = await service.create({ workspaceRoot: root, threadId: 't1', stepId: 's1' })

    const patch = await service.diff({ workspaceRoot: root, from: first.id, to: second.id })
    expect(patch).toContain('-one')
    expect(patch).toContain('+two')

    // 最新检查点之后工作树是干净的：可以安全回到上一版
    const restored = await service.restore({ workspaceRoot: root, checkpoint: first.id, paths: ['a.txt'] })
    expect(restored.restored).toEqual(['a.txt'])
    expect(await readFile(file, 'utf8')).toBe('one')

    const listed = await service.list(root)
    expect(listed).toHaveLength(3)
    expect(listed[2]?.label).toBe('轮次开始')
    expect(listed[0]?.label).toContain('revert')
  })

  test('diffPaths / changedPaths / expect 三方核对，并删除这一轮新建的文件', async () => {
    const root = await workspace()
    const service = createCheckpointService({ dir: path.join(root, '.shadow') })
    const a = path.join(root, 'a.txt')
    const b = path.join(root, 'b.txt')
    await writeFile(a, 'one')
    const start = await service.create({ workspaceRoot: root, threadId: 't1', label: '轮次开始' })
    await writeFile(a, 'two')
    await writeFile(b, 'new')
    const end = await service.create({ workspaceRoot: root, threadId: 't1', label: '轮次结束' })

    expect(await service.diffPaths({ workspaceRoot: root, from: start.id, to: end.id })).toEqual(['a.txt', 'b.txt'])
    expect(await service.diffNumstat({ workspaceRoot: root, from: start.id, to: end.id })).toEqual([
      { path: 'a.txt', added: 1, removed: 1, binary: false },
      { path: 'b.txt', added: 1, removed: 0, binary: false },
    ])
    expect(await service.readFile({ workspaceRoot: root, checkpoint: start.id, path: 'a.txt' })).toBe('one')
    expect(await service.readFile({ workspaceRoot: root, checkpoint: end.id, path: 'a.txt' })).toBe('two')
    expect(await service.readFile({ workspaceRoot: root, checkpoint: start.id, path: 'b.txt' })).toBeNull()
    expect(await service.readFile({ workspaceRoot: root, checkpoint: end.id, path: 'b.txt' })).toBe('new')
    expect((await service.changedPaths({ workspaceRoot: root, checkpoint: start.id })).sort()).toEqual([
      'a.txt',
      'b.txt',
    ])

    await service.restore({
      workspaceRoot: root,
      checkpoint: start.id,
      expect: end.id,
      paths: ['a.txt', 'b.txt'],
    })
    expect(await readFile(a, 'utf8')).toBe('one')
    await expect(readFile(b, 'utf8')).rejects.toThrow()
  })

  test('二进制文件在 numstat 里标 binary，行数记 0（图片不能按行比）', async () => {
    const root = await workspace()
    const service = createCheckpointService({ dir: path.join(root, '.shadow') })
    const start = await service.create({ workspaceRoot: root, threadId: 't1', label: '轮次开始' })
    /* PNG 头就带 NUL：git 自己就把它认成二进制。 */
    await writeFile(path.join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
    const end = await service.create({ workspaceRoot: root, threadId: 't1', label: '轮次结束' })

    expect(await service.diffNumstat({ workspaceRoot: root, from: start.id, to: end.id })).toEqual([
      { path: 'shot.png', added: 0, removed: 0, binary: true },
    ])
  })

  test('检查点之后手动改过文件时拒绝恢复', async () => {
    const root = await workspace()
    const service = createCheckpointService({ dir: path.join(root, '.shadow') })
    const file = path.join(root, 'a.txt')
    await writeFile(file, 'one')
    const first = await service.create({ workspaceRoot: root })
    await writeFile(file, 'two')
    await service.create({ workspaceRoot: root })
    await writeFile(file, 'manual')

    await expect(
      service.restore({ workspaceRoot: root, checkpoint: first.id, paths: ['a.txt'] }),
    ).rejects.toMatchObject({
      code: 'checkpoints.conflict',
    })
  })

  test('拒绝工作区之外的路径', async () => {
    const root = await workspace()
    const service = createCheckpointService({ dir: path.join(root, '.shadow') })
    await writeFile(path.join(root, 'a.txt'), 'one')
    const first = await service.create({ workspaceRoot: root })
    await expect(
      service.restore({ workspaceRoot: root, checkpoint: first.id, paths: ['../outside.txt'] }),
    ).rejects.toMatchObject({ code: 'checkpoints.invalid_path' })
  })
})
