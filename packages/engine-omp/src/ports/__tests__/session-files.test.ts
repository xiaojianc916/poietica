import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EngineErrorCode } from '@poietica/engine'
import { noopLogger } from '@poietica/foundation'
import { OmpSessionFilesPort } from '../session-files'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makePort(): { port: OmpSessionFilesPort; sessions: string; workspace: string } {
  const sessions = mkdtempSync(path.join(tmpdir(), 'poietica-sessions-'))
  const workspace = mkdtempSync(path.join(tmpdir(), 'poietica-ws-'))
  made.push(sessions, workspace)
  return {
    port: new OmpSessionFilesPort({ sessionDir: sessions, logger: noopLogger }),
    sessions,
    workspace,
  }
}

/** 一份最小的会话文件：256 字节的 title 槽 + 表头（omp 的物理格式，N 节）。 */
function writeSession(file: string, id: string): void {
  const slot = JSON.stringify({ type: 'title', v: 1, title: 'x', updatedAt: '2026-01-01T00:00:00.000Z' })
  const padded = slot.padEnd(256, ' ')
  const header = JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '.' })
  writeFileSync(file, `${padded}\n${header}\n`, 'utf8')
}

describe('SessionFilesPort', () => {
  test('exists 对不存在的路径交回 false，不当成异常', async () => {
    const { port, sessions } = makePort()
    expect(await port.exists(path.join(sessions, 'nope.jsonl'))).toBe(false)
  })

  /* omp 知识 #14：会话文件在首次水合之后才落盘，所以四个动作用之前都要 exists 校验。 */
  test('fork / exportHtml / exportMarkdown / delete 对不存在的文件抛 session_file_missing', async () => {
    const { port, sessions, workspace } = makePort()
    const missing = path.join(sessions, 'missing.jsonl')
    const missingCode = EngineErrorCode.sessionFileMissing
    await expect(port.fork(missing, 0)).rejects.toMatchObject({ code: missingCode })
    await expect(port.delete(missing)).rejects.toMatchObject({ code: missingCode })
    await expect(port.exportHtml(missing, path.join(workspace, 'out.html'))).rejects.toMatchObject({
      code: missingCode,
    })
    await expect(port.exportMarkdown(missing)).rejects.toMatchObject({ code: missingCode })
  })

  test('delete 删掉文件与它的产物目录', async () => {
    const { port, sessions } = makePort()
    const file = path.join(sessions, '2026-01-01_abc.jsonl')
    writeSession(file, 'abc')
    expect(await port.exists(file)).toBe(true)
    await port.delete(file)
    expect(await port.exists(file)).toBe(false)
  })

  test('fork 造出一条独立的新会话文件，原文件不受影响', async () => {
    const { port, sessions, workspace } = makePort()
    const file = path.join(sessions, '2026-01-01_src.jsonl')
    writeSession(file, 'src')
    const before = readText(file)
    const forked = await port.fork(file, 0)
    expect(forked.sessionId).not.toBe('src')
    expect(forked.sessionFile).not.toBe(file)
    expect(await port.exists(forked.sessionFile)).toBe(true)
    expect(readText(file)).toBe(before)
    void workspace
  })

  test('fork 丢轮数超过实际轮数时如实报错，不静默夹到边界', async () => {
    const { port, sessions } = makePort()
    const file = path.join(sessions, '2026-01-01_src2.jsonl')
    writeSession(file, 'src2')
    await expect(port.fork(file, 3)).rejects.toThrow(/只能丢/)
  })
})

function readText(file: string): string {
  return require('node:fs').readFileSync(file, 'utf8') as string
}
