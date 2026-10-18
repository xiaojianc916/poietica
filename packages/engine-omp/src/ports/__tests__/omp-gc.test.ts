import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SystemErrorCode } from '@poietica/foundation'
import { coreSelfCommand, ompMediaGc, parseGcOutput } from '../omp-gc'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ENTRY = path.join(import.meta.dir, 'fixtures', 'core-entry.ts')
const viaFixture = () => [process.execPath, ENTRY]
const hash = (c: string) => c.repeat(64)

/** 一个 omp agent 目录：一条会话引用 a…a；blob 目录里 a、b（b 带硬链接旁路）、c（刚写的） */
function agentDir(): { dir: string; blobs: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-gc-'))
  made.push(dir)
  const sessions = path.join(dir, 'sessions', '--proj--')
  const blobs = path.join(dir, 'blobs')
  mkdirSync(sessions, { recursive: true })
  mkdirSync(blobs, { recursive: true })
  writeFileSync(
    path.join(sessions, 's.jsonl'),
    `${JSON.stringify({ type: 'message', message: { content: [{ type: 'image', data: `blob:sha256:${hash('a')}` }] } })}\n`,
  )
  const old = new Date(Date.now() - 60 * 60_000)
  for (const c of ['a', 'b', 'c']) writeFileSync(path.join(blobs, hash(c)), Buffer.alloc(1000, c))
  linkSync(path.join(blobs, hash('b')), path.join(blobs, `${hash('b')}.png`))
  for (const name of [hash('a'), hash('b'), `${hash('b')}.png`]) utimesSync(path.join(blobs, name), old, old)
  return { dir, blobs }
}

describe('会话媒体回收（omp gc 的 blobs 段，子进程）', () => {
  test('G-1 只删没被引用、且过了写入宽限的；会话文件一个不动', async () => {
    const { dir, blobs } = agentDir()
    const result = await ompMediaGc(dir, { command: viaFixture })()
    expect(result.deletedFiles).toBe(2) // b 与 b.png
    expect(result.errors).toEqual([])
    expect(existsSync(path.join(blobs, hash('a')))).toBe(true)
    expect(existsSync(path.join(blobs, hash('b')))).toBe(false)
    expect(existsSync(path.join(blobs, `${hash('b')}.png`))).toBe(false)
    expect(existsSync(path.join(blobs, hash('c')))).toBe(true) // 刚写的：在宽限之内
    expect(existsSync(path.join(dir, 'sessions', '--proj--', 's.jsonl'))).toBe(true)
    expect(existsSync(path.join(dir, 'sessions', 'archive'))).toBe(false) // 不跑 archive 段
  })

  test('G-2 子进程失败如实报错（缺参数 → 退出码 2）', async () => {
    const run = ompMediaGc('', { command: viaFixture })
    await expect(run()).rejects.toMatchObject({ code: SystemErrorCode.internal })
  })

  test('G-3 中止：子进程被结束，报错而不是挂着', async () => {
    const { dir } = agentDir()
    const controller = new AbortController()
    controller.abort()
    await expect(ompMediaGc(dir, { command: viaFixture })(controller.signal)).rejects.toBeDefined()
  })

  test('G-4 parseGcOutput 读 blobs 段；看不懂就报错，不当成 0', () => {
    const json = JSON.stringify(
      { agentDir: '/x', apply: true, blobs: { deleted: 3, bytes: 42, errors: ['e'] } },
      null,
      2,
    )
    expect(parseGcOutput(`warning line\n${json}\n`)).toEqual({ deletedFiles: 3, freedBytes: 42, errors: ['e'] })
    expect(() => parseGcOutput('')).toThrow()
    expect(() => parseGcOutput('{"agentDir":"/x"}')).toThrow()
  })

  test('G-5 coreSelfCommand：编译版是 exe 本身；开发版是 bun + Core 入口；不在 Core 入口里就拒绝（不退回别的 omp）', () => {
    expect(coreSelfCommand(true, null)).toEqual([process.execPath])
    expect(coreSelfCommand(false, '/app/main.ts')).toEqual([process.execPath, '/app/main.ts'])
    expect(() => coreSelfCommand(false, null)).toThrow()
  })
})
