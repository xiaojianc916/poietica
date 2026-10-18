import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { jsonlFileSink } from '../jsonl-file-sink'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-logging-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('jsonlFileSink', () => {
  test('写 3 条 → 文件 3 行，每行可 JSON.parse', () => {
    const file = path.join(tempDir(), 'x.log')
    const sink = jsonlFileSink({ file })
    sink.write({ ts: 1, level: 'info', msg: 'a' })
    sink.write({ ts: 2, level: 'warn', msg: 'b' })
    sink.write({ ts: 3, level: 'error', msg: 'c' })
    sink.close()
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(['a', 'b', 'c'])
  })

  test('maxBytes: 200, keep: 2 连写 20 条 → 轮转且当前文件不超过 200 字节', () => {
    const file = path.join(tempDir(), 'x.log')
    const sink = jsonlFileSink({ file, maxBytes: 200, keep: 2 })
    for (let i = 0; i < 20; i++) sink.write({ ts: 1_700_000_000_000 + i, level: 'info', msg: `m${i}` })
    sink.close()
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(existsSync(`${file}.2`)).toBe(true)
    expect(existsSync(`${file}.3`)).toBe(false)
    expect(statSync(file).size).toBeLessThanOrEqual(200)
  })

  test('记录中的 token 在文件里是 [redacted]', () => {
    const file = path.join(tempDir(), 'x.log')
    const sink = jsonlFileSink({ file })
    sink.write({ ts: 1, level: 'info', msg: 'auth', token: 'sk-secret' })
    sink.close()
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('[redacted]')
    expect(text).not.toContain('sk-secret')
  })

  test('文件所在目录不存在时自动创建', () => {
    const file = path.join(tempDir(), 'nested', 'deeper', 'x.log')
    const sink = jsonlFileSink({ file })
    sink.write({ ts: 1, level: 'info', msg: 'a' })
    sink.close()
    expect(existsSync(file)).toBe(true)
  })
})

describe('jsonlFileSink：按批落盘', () => {
  const linesOf = (file: string): string[] =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => (JSON.parse(line) as { msg: string }).msg)
      : []

  test('普通记录先攒着：flush 之前文件里没有，flush 之后一次写齐', () => {
    const file = path.join(tempDir(), 'x.log')
    const sink = jsonlFileSink({ file, flushMs: 60_000 })
    sink.write({ ts: 1, level: 'info', msg: 'a' })
    sink.write({ ts: 2, level: 'debug', msg: 'b' })
    expect(linesOf(file)).toEqual([])
    sink.flush()
    expect(linesOf(file)).toEqual(['a', 'b'])
    sink.close()
  })

  test('error 级记录当场落盘，并带上它之前攒着的记录（顺序不乱）', () => {
    const file = path.join(tempDir(), 'x.log')
    const sink = jsonlFileSink({ file, flushMs: 60_000 })
    sink.write({ ts: 1, level: 'info', msg: 'before' })
    sink.write({ ts: 2, level: 'error', msg: 'boom' })
    expect(linesOf(file)).toEqual(['before', 'boom'])
    sink.close()
  })

  test('到点自动落盘', async () => {
    const file = path.join(tempDir(), 'x.log')
    const sink = jsonlFileSink({ file, flushMs: 10 })
    sink.write({ ts: 1, level: 'info', msg: 'later' })
    expect(linesOf(file)).toEqual([])
    await Bun.sleep(40)
    expect(linesOf(file)).toEqual(['later'])
    sink.close()
  })

  test('攒满 64 KB 不等定时器', () => {
    const file = path.join(tempDir(), 'x.log')
    const sink = jsonlFileSink({ file, flushMs: 60_000 })
    const big = 'x'.repeat(1024)
    for (let i = 0; i < 70; i++) sink.write({ ts: i, level: 'info', msg: big })
    expect(linesOf(file).length).toBeGreaterThanOrEqual(60)
    sink.close()
  })

  test('flushMs: 0 → 每条同步写', () => {
    const file = path.join(tempDir(), 'x.log')
    const sink = jsonlFileSink({ file, flushMs: 0 })
    sink.write({ ts: 1, level: 'info', msg: 'now' })
    expect(linesOf(file)).toEqual(['now'])
    sink.close()
  })
})
