import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionManager } from '@oh-my-pi/pi-coding-agent/session/session-manager'
import { noopLogger, SystemErrorCode } from '@poietica/foundation'
import { type OmpMessage, projectHistoryPage } from '../../projector/history'
import { GOAL_CONTINUATION_TYPE, SKILL_MESSAGE_TYPE } from '../../session/prompt'
import { OmpSessionFilesPort } from '../session-files'

/*
 * 分叉按**轮号**截（`keepTurns` = 时间线上那一轮的 turn.ordinal），并且截断要**落盘**。
 *
 * 旧做法是「从尾部往回数 N 个 role:user」再 `branch()`：
 * - `branch()` 只挪内存里的叶子，omp 重开会话按最后一条物理记录还原叶子 —— 分出来的线程一打开又是整条历史（F-1）；
 * - 技能消息（custom）与目标续跑也开轮，却不是 role:user，数出来的位置与屏幕上的轮对不上（F-4 / F-5）。
 * 这里的判据一律是「重开分叉出来的文件，屏幕上画出来的是不是前 keepTurns 轮」。
 */

const made: string[] = []
const noGc = async () => ({ deletedFiles: 0, freedBytes: 0, errors: [] })
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

type Step =
  | { readonly kind: 'user' | 'reply'; readonly text: string }
  | { readonly kind: 'skill' | 'continuation'; readonly text: string }
  | { readonly kind: 'compaction' }

async function sessionOf(steps: readonly Step[]): Promise<{ port: OmpSessionFilesPort; file: string; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-fork-'))
  made.push(dir)
  const manager = SessionManager.create(dir, dir)
  let firstKept = ''
  for (const step of steps) {
    if (step.kind === 'user') {
      const id = manager.appendMessage(user(step.text))
      if (firstKept === '') firstKept = id
    } else if (step.kind === 'reply') manager.appendMessage(reply(step.text))
    else if (step.kind === 'skill') {
      manager.appendCustomMessageEntry(SKILL_MESSAGE_TYPE, step.text, true, { name: 'demo' }, 'user', tick())
    } else if (step.kind === 'continuation') {
      manager.appendCustomMessageEntry(GOAL_CONTINUATION_TYPE, step.text, false, undefined, 'agent', tick())
    } else manager.appendCompaction('摘要', undefined, firstKept, 1000, {})
  }
  await manager.flush()
  const file = manager.getSessionFile()
  await manager.close()
  if (file === undefined) throw new Error('omp 没有落盘')
  return { port: new OmpSessionFilesPort({ sessionDir: dir, mediaGc: noGc, logger: noopLogger }), file, dir }
}

/** 重开一份会话文件，按时间线的历史分页画出来：每轮的开场一句 + 正文 */
async function screenOf(file: string, dir: string): Promise<string[][]> {
  const manager = await SessionManager.open(file, dir)
  try {
    const messages = manager.buildSessionContext({ transcript: true, collapseCompactedHistory: false })
      .messages as unknown as readonly OmpMessage[]
    const page = projectHistoryPage(messages, null, { pageSize: 100 })
    return page.items.flatMap((item) =>
      item.kind !== 'turn'
        ? []
        : [
            [
              item.prompt ?? `(${item.origin.kind})`,
              ...item.steps.flatMap((s) => s.frames.map((f) => (f.kind === 'text' ? f.text : f.kind))),
            ],
          ],
    )
  } finally {
    await manager.close()
  }
}

const THREE: readonly Step[] = [
  { kind: 'user', text: 'q1' },
  { kind: 'reply', text: 'a1' },
  { kind: 'user', text: 'q2' },
  { kind: 'reply', text: 'a2' },
  { kind: 'user', text: 'q3' },
  { kind: 'reply', text: 'a3' },
]

describe('fork 按轮号截断', () => {
  test('F-1 只留前 2 轮：分出来的文件重开之后屏幕上就是前 2 轮（截断落了盘），原文件不动', async () => {
    const { port, file, dir } = await sessionOf(THREE)
    const before = readFileSync(file, 'utf8')
    const forked = await port.fork(file, 2)
    expect(await screenOf(forked.sessionFile, dir)).toEqual([
      ['q1', 'a1'],
      ['q2', 'a2'],
    ])
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  test('F-0 留 0 轮：一轮不剩（「从第 1 轮重写」），原文件不动、重开不复活旧历史', async () => {
    const { port, file, dir } = await sessionOf(THREE)
    const before = readFileSync(file, 'utf8')
    const forked = await port.fork(file, 0)
    expect(await screenOf(forked.sessionFile, dir)).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  test('F-2 不给 keepTurns：整条复制', async () => {
    const { port, file, dir } = await sessionOf(THREE)
    const forked = await port.fork(file)
    expect(await screenOf(forked.sessionFile, dir)).toEqual(await screenOf(file, dir))
  })

  test('F-3 留的轮数等于现有轮数 = 整条；超出、负数、非整数都如实报 invalid_params，不夹到边界', async () => {
    const { port, file, dir } = await sessionOf(THREE)
    expect(await screenOf((await port.fork(file, 3)).sessionFile, dir)).toHaveLength(3)
    await expect(port.fork(file, 4)).rejects.toMatchObject({ code: SystemErrorCode.invalidParams })
    await expect(port.fork(file, -1)).rejects.toMatchObject({ code: SystemErrorCode.invalidParams })
    await expect(port.fork(file, 1.5)).rejects.toMatchObject({ code: SystemErrorCode.invalidParams })
  })

  test('F-7 截断 / 定名失败不留副本：目录里还是原来那几样（不再每试一次多一整份克隆）', async () => {
    const { port, file, dir } = await sessionOf(THREE)
    const before = readdirSync(dir).sort()
    await expect(port.fork(file, 4)).rejects.toMatchObject({ code: SystemErrorCode.invalidParams })
    await expect(port.fork(file, 1, '   ')).rejects.toMatchObject({ code: SystemErrorCode.invalidParams })
    expect(readdirSync(dir).sort()).toEqual(before)
  })

  test('F-4 技能开的那一轮（custom，不是 role:user）也是一轮：留 1 轮就只剩第 1 轮', async () => {
    const { port, file, dir } = await sessionOf([
      { kind: 'user', text: 'q1' },
      { kind: 'reply', text: 'a1' },
      { kind: 'skill', text: '用技能' },
      { kind: 'reply', text: 'a2' },
      { kind: 'user', text: 'q3' },
      { kind: 'reply', text: 'a3' },
    ])
    expect(await screenOf(file, dir)).toHaveLength(3)
    expect(await screenOf((await port.fork(file, 1)).sessionFile, dir)).toEqual([['q1', 'a1']])
    expect(await screenOf((await port.fork(file, 2)).sessionFile, dir)).toHaveLength(2)
  })

  test('F-5 目标续跑开的轮：留 1 轮时续跑那一轮及之后都不在分支里', async () => {
    const { port, file, dir } = await sessionOf([
      { kind: 'user', text: 'q1' },
      { kind: 'reply', text: 'a1' },
      { kind: 'continuation', text: '继续' },
      { kind: 'reply', text: 'a2' },
      { kind: 'user', text: 'q3' },
      { kind: 'reply', text: 'a3' },
    ])
    expect(await screenOf(file, dir)).toHaveLength(3)
    expect(await screenOf((await port.fork(file, 1)).sessionFile, dir)).toEqual([['q1', 'a1']])
  })

  test('F-6 压缩之后照样能截到压缩之前的轮', async () => {
    const { port, file, dir } = await sessionOf([...THREE.slice(0, 4), { kind: 'compaction' }, ...THREE.slice(4)])
    expect(await screenOf((await port.fork(file, 1)).sessionFile, dir)).toEqual([['q1', 'a1']])
    expect(await screenOf((await port.fork(file, 2)).sessionFile, dir)).toEqual([
      ['q1', 'a1'],
      ['q2', 'a2'],
    ])
  })
})

describe('会话名写进 omp（P4）', () => {
  /** 重开文件读 omp 记下的名字与来源 */
  async function nameOf(file: string, dir: string): Promise<{ name: string | undefined; source: unknown }> {
    const manager = await SessionManager.open(file, dir)
    try {
      return { name: manager.getSessionName(), source: manager.titleSource }
    } finally {
      await manager.close()
    }
  }

  test('N-1 rename 把用户定名写进会话头（source=user），重开读得回；空名报 invalid_params', async () => {
    const { port, file, dir } = await sessionOf([
      { kind: 'user', text: 'u1' },
      { kind: 'reply', text: 'a1' },
    ])
    await port.rename(file, '我起的名字')
    expect(await nameOf(file, dir)).toEqual({ name: '我起的名字', source: 'user' })
    await expect(port.rename(file, '   ')).rejects.toMatchObject({ code: SystemErrorCode.invalidParams })
  })

  test('N-2 fork 带名字：新会话以用户定名落盘，原会话的名字不动', async () => {
    const { port, file, dir } = await sessionOf([
      { kind: 'user', text: 'u1' },
      { kind: 'reply', text: 'a1' },
    ])
    await port.rename(file, '原名')
    const forked = await port.fork(file, 1, '原名（分支）')
    expect(await nameOf(forked.sessionFile, dir)).toEqual({ name: '原名（分支）', source: 'user' })
    expect((await nameOf(file, dir)).name).toBe('原名')
  })
})
