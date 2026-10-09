import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sha256File } from '../hash'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fs-kit-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sha256File', () => {
  test("内容 'abc' 的文件得到标准 SHA-256", async () => {
    const file = path.join(dir, 'abc.txt')
    await writeFile(file, 'abc')
    expect(await sha256File(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
