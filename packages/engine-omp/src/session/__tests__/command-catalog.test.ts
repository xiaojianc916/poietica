import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCommandCatalog } from '../slash-commands'

/*
 * U-1：入口页（还没有对话）的命令表 —— 真 omp 的内置注册表，不开会话。
 * 说明是中文（command-text.ts）；只对已有对话有意义的、GUI 拦下的都不在表里。
 */
describe('入口页的命令表', () => {
  test('内置命令说中文；压缩、重试、置顶、搬目录这类不在表里', async () => {
    const list = await listCommandCatalog(null)
    const names = list.map((command) => command.name)

    expect(names).toContain('model')
    expect(list.find((command) => command.name === 'model')?.description).toBe('切换模型')
    for (const absent of ['compact', 'handoff', 'retry', 'rename', 'pin', 'move', 'wt', 'stats', 'trace']) {
      expect(names).not.toContain(absent)
    }
    expect(list.every((command) => command.source === 'builtin')).toBe(true)
  })

  test('次序按 command-text 的表：常用的在前', async () => {
    const names = (await listCommandCatalog(null)).map((command) => command.name)

    expect(names.indexOf('context')).toBeLessThan(names.indexOf('model'))
    expect(names.indexOf('model')).toBeLessThan(names.indexOf('mcp'))
  })

  test('工作区里的文件命令进表、归为文件命令；omp 随包带的 init 归为内置', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-'))
    try {
      await mkdir(join(dir, '.omp', 'commands'), { recursive: true })
      await writeFile(
        join(dir, '.omp', 'commands', 'review-diff.md'),
        '---\ndescription: 审查当前改动\n---\n审查 $ARGUMENTS\n',
      )
      const list = await listCommandCatalog(dir)

      expect(list.find((command) => command.name === 'review-diff')).toMatchObject({
        source: 'file',
        description: '审查当前改动',
      })
      expect(list.find((command) => command.name === 'init')).toMatchObject({
        source: 'builtin',
        description: '为当前代码库生成 AGENTS.md',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
