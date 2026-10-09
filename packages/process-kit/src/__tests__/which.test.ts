import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathEntries, which } from '../which'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'process-kit-which-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('which', () => {
  test('找到 PATH 中的 cmd.exe', async () => {
    const found = await which('cmd')
    expect(found).not.toBeNull()
    expect((found ?? '').toLowerCase().endsWith('\\cmd.exe')).toBe(true)
  })

  test('找不到时返回 null', async () => {
    expect(await which('definitely-not-here-xyz')).toBeNull()
  })

  test('按传入的 env 查找：键名大小写不敏感，PATHEXT 未给时用默认值', async () => {
    await writeFile(path.join(dir, 'tool.cmd'), '@echo off\r\n')
    // Windows 文件系统不区分大小写：默认 PATHEXT 是大写，命中的路径可能是 tool.CMD
    const found = await which('tool', { Path: dir })
    expect(found?.toLowerCase()).toBe(path.join(dir, 'tool.cmd').toLowerCase())
  })

  test('带扩展名的名字也能找到', async () => {
    const found = await which('cmd.exe')
    expect(found).not.toBeNull()
    expect((found ?? '').toLowerCase().endsWith('\\cmd.exe')).toBe(true)
  })
})

describe('pathEntries', () => {
  test('拆分 PATH：去掉引号与空项，键名大小写不敏感', () => {
    expect(pathEntries({ Path: '"C:\\a b";C:\\c;;' })).toEqual(['C:\\a b', 'C:\\c'])
  })
})
