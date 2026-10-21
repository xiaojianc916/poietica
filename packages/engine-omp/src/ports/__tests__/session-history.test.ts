import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionManager } from '@oh-my-pi/pi-coding-agent/session/session-manager'
import { EngineErrorCode } from '@poietica/engine'
import { isAppError, noopLogger } from '@poietica/foundation'
import type { TranscriptPage } from '@poietica/transcript'
import { hashMediaRef } from '../../projector/media'
import { SessionHistoryReader } from '../session-history'

/*
 * 冷读（SessionFilesPort.readPage）的三条承诺：交出与历史投影同一页、从不写会话文件、文件变了就重读（缓存不过期不算数）。
 * 与「重新打开会话再 page()」的逐页一致性由引擎一致性用例 C-READ-PAGE 在真实 omp 引擎上钉住；这里只测读取器自己的账。
 */

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let clock = Date.parse('2026-01-01T00:00:00.000Z')
const tick = (): number => {
  clock += 1000
  return clock
}
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
const user = (text: string) => ({ role: 'user', content: text, attribution: 'user', timestamp: tick() }) as never
const reply = (text: string) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'x',
    provider: 'x',
    model: 'x',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO },
    stopReason: 'stop',
    timestamp: tick(),
  }) as never

function reader(): SessionHistoryReader {
  return new SessionHistoryReader({
    mediaRef: hashMediaRef,
    obfuscatorFor: async () => undefined,
    now: () => 0,
    logger: noopLogger,
  })
}

async function sessionWith(turns: number): Promise<{ file: string; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-cold-'))
  made.push(dir)
  const manager = SessionManager.create(dir, dir)
  for (let i = 0; i < turns; i++) {
    manager.appendMessage(user(`q${i}`))
    manager.appendMessage(reply(`a${i}`))
  }
  await manager.flush()
  const file = manager.getSessionFile()
  await manager.close()
  if (file === undefined) throw new Error('omp 没有落盘')
  return { file, dir }
}

function prompts(page: TranscriptPage): string[] {
  return page.items.flatMap((item) => (item.kind === 'turn' && item.prompt !== undefined ? [item.prompt] : []))
}

describe('SessionHistoryReader（没开着的会话的只读时间线）', () => {
  test('交出历史页，按轮号往前翻页', async () => {
    const { file } = await sessionWith(25)
    const cold = reader()
    const latest = await cold.page(file, 'main', null)
    expect(prompts(latest)).toHaveLength(20)
    expect(prompts(latest)[19]).toBe('q24')
    expect(latest.hasMoreOlder).toBe(true)
    const older = await cold.page(file, 'main', 't6')
    expect(prompts(older)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4'])
    expect(older.hasMoreOlder).toBe(false)
  })

  test('只读：文件的字节与修改时刻都不变', async () => {
    const { file } = await sessionWith(2)
    const before = statSync(file)
    await reader().page(file, 'main', null)
    const after = statSync(file)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  test('文件变了就重读：缓存按大小与修改时刻认，不会交出过期的一页', async () => {
    const { file, dir } = await sessionWith(1)
    const cold = reader()
    expect(prompts(await cold.page(file, 'main', null))).toEqual(['q0'])
    const manager = await SessionManager.open(file, dir)
    manager.appendMessage(user('q1'))
    manager.appendMessage(reply('a1'))
    await manager.flush()
    await manager.close()
    expect(prompts(await cold.page(file, 'main', null))).toEqual(['q0', 'q1'])
  })

  test('文件不在报 engine.session_file_missing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poietica-cold-'))
    made.push(dir)
    const missing = await reader()
      .page(path.join(dir, 'gone.jsonl'), 'main', null)
      .catch((error: unknown) => error)
    expect(isAppError(missing) && missing.code).toBe(EngineErrorCode.sessionFileMissing)
  })

  test('子代理通道：认不出的号与没有文件的号都交空页，不抛', async () => {
    const { file } = await sessionWith(1)
    const cold = reader()
    expect((await cold.page(file, 'main\u0000x', null)).items).toEqual([])
    expect((await cold.page(file, 'Nobody', null)).items).toEqual([])
  })

  test('子代理通道读 <产物目录>/<agentId>.jsonl', async () => {
    const { file } = await sessionWith(1)
    const artifacts = file.slice(0, -'.jsonl'.length)
    mkdirSync(artifacts, { recursive: true })
    const sub = SessionManager.create(artifacts, artifacts)
    sub.appendMessage(user('sub-q'))
    sub.appendMessage(reply('sub-a'))
    await sub.flush()
    const subFile = sub.getSessionFile()
    await sub.close()
    if (subFile === undefined) throw new Error('omp 没有落盘')
    writeFileSync(path.join(artifacts, 'Explorer.jsonl'), await Bun.file(subFile).text())
    const page = await reader().page(file, 'Explorer', null)
    expect(prompts(page)).toEqual(['sub-q'])
  })
})
