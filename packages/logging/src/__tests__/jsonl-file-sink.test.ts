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
