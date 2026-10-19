import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseRelayToken } from '@poietica/engine'
import { ensureRelayToken, prepareRelayToken, RELAY_TOKEN_FILE_ENV } from '../relay-token'

const dirs: string[] = []
function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-token-'))
  dirs.push(dir)
  return path.join(dir, 'core', 'relay.token')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ensureRelayToken', () => {
  test('RT-H1 第一次调用生成 64 位口令并落盘（目录不存在也行），不留临时文件', () => {
    const file = tempFile()
    const token = ensureRelayToken(file)
    expect(parseRelayToken(token)).toBe(token)
    expect(readFileSync(file, 'utf8')).toBe(token)
    expect(readdirSync(path.dirname(file))).toEqual(['relay.token'])
  })

  test('RT-H2 已有的合法口令原样复用：broker 用旧环境拉起的 relay 读到的仍是同一份', () => {
    const file = tempFile()
    const first = ensureRelayToken(file)
    expect(ensureRelayToken(file)).toBe(first)
  })

  test('RT-H3 文件被改坏时重建', () => {
    const file = tempFile()
    ensureRelayToken(file)
    writeFileSync(file, 'not-a-token')
    const rebuilt = ensureRelayToken(file)
    expect(parseRelayToken(rebuilt)).toBe(rebuilt)
    expect(readFileSync(file, 'utf8')).toBe(rebuilt)
  })

  test.skipIf(process.platform === 'win32')('RT-H4 POSIX 上只有本人可读写', () => {
    const file = tempFile()
    ensureRelayToken(file)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('prepareRelayToken', () => {
  test('RT-H5 生成口令并只把文件路径放进环境（口令本身不进环境）', () => {
    const file = tempFile()
    const env: Record<string, string | undefined> = {}
    prepareRelayToken({ relayTokenFile: file }, env)
    expect(env[RELAY_TOKEN_FILE_ENV]).toBe(file)
    const token = readFileSync(file, 'utf8')
    expect(parseRelayToken(token)).toBe(token)
    expect(Object.values(env)).not.toContain(token)
  })
})
