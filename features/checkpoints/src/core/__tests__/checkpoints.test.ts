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
