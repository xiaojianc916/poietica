import '../../__tests__/omp-home'

import { describe, expect, test } from 'bun:test'
import type { EngineSessionEvent } from '@poietica/engine'
import type { TranscriptOperation } from '@poietica/transcript'
import { OmpSession, type OmpSessionHost } from '../session'
import type { BuiltinCommandHooks } from '../slash-commands'
import { hostOf } from './host-fixture'

/*
 * U-04：斜杠命令跑起来时屏幕上有什么。
 * - `/compact`、`/handoff` 不画原句，开一格「正在压缩 / 正在生成交接文档」（omp 手动跑它们时不发压缩事件）；
 * - 其余命令照旧先画原句（`/retry` 排出的那一轮要有地方落）；
 * - 命令输出经 command-output.ts：已在别处体现的不推，认得的说中文。
 */

interface Recorded {
  readonly ops: TranscriptOperation[]
  readonly outputs: string[]
  readonly events: EngineSessionEvent[]
}

function record(session: OmpSession): Recorded {
  const seen: Recorded = { ops: [], outputs: [], events: [] }
  session.subscribe((event) => {
    seen.events.push(event)
    if (event.type === 'timeline') seen.ops.push(...event.ops)
    if (event.type === 'commandOutput') seen.outputs.push(event.text)
  })
  return seen
}

/** 一条内置命令：执行时按 say 依次吐输出，然后就地办完 */
function builtin(name: string, say: readonly string[], gate?: Promise<void>): Partial<OmpSessionHost> {
  return {
    resolveCommand: async () => ({ name, source: 'builtin' }),
    runBuiltinCommand: async (_text: string, hooks: BuiltinCommandHooks) => {
      if (gate !== undefined) await gate
      for (const line of say) hooks.output(line)
      return { kind: 'local' }
    },
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('斜杠命令的呈现', () => {
  test('/compact：不画原句，开一格压缩行；成功那句不推；收口整页重取', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const session = new OmpSession(
      hostOf(builtin('compact', ['Compaction complete. Tokens: 39919 -> 23710 (saved 16209).'], gate)),
      { sessionId: 's1', sessionFile: 'f1' },
    )
    const seen = record(session)

    await session.runCommand('/compact')
    const marker = seen.ops.find((op) => op.op === 'marker.upsert')
    expect(marker?.op === 'marker.upsert' ? marker.item.payload : undefined).toEqual({
      state: 'running',
      reason: 'manual',
      action: 'context-full',
    })
    /* 原句没有画成一轮人话 */
    expect(seen.ops.some((op) => op.op === 'turn.upsert')).toBe(false)

    release()
    await settle()
    expect(seen.outputs).toEqual([])
    expect(seen.events.some((event) => event.type === 'timelineReset')).toBe(true)
    expect(session.state()).toBe('idle')
  })

  test('/handoff：那一格说的是交接；失败原因说中文', async () => {
    const session = new OmpSession(
      hostOf(builtin('handoff', ['Handoff failed: Nothing to hand off (no messages yet)'])),
      { sessionId: 's1', sessionFile: 'f1' },
    )
    const seen = record(session)

    await session.runCommand('/handoff')
    await settle()
    const marker = seen.ops.find((op) => op.op === 'marker.upsert')
    expect(marker?.op === 'marker.upsert' ? marker.item.payload : undefined).toMatchObject({ action: 'handoff' })
    expect(seen.outputs).toEqual(['交接失败：还没有可交接的对话'])
  })

  test('其余命令照旧先画原句；报表类输出原样推，查看当前模型说中文', async () => {
    const session = new OmpSession(
      hostOf(builtin('switch', ['Current model: deepseek/deepseek-v4', 'Context window: 1000 tokens'])),
      { sessionId: 's1', sessionFile: 'f1' },
    )
    const seen = record(session)

    await session.runCommand('/switch')
    await settle()
    expect(seen.ops.some((op) => op.op === 'turn.upsert')).toBe(true)
    expect(seen.ops.some((op) => op.op === 'marker.upsert')).toBe(false)
    expect(seen.outputs).toEqual(['当前模型：deepseek/deepseek-v4', 'Context window: 1000 tokens'])
  })

  test('命令抛错：认得的原因说中文，走命令输出那一块', async () => {
    const session = new OmpSession(
      hostOf({
        resolveCommand: async () => ({ name: 'handoff', source: 'builtin' }),
        runBuiltinCommand: async () => {
          throw new Error('Nothing to hand off (already compacted)')
        },
      }),
      { sessionId: 's1', sessionFile: 'f1' },
    )
    const seen = record(session)

    await session.runCommand('/handoff')
    await settle()
    expect(seen.outputs).toEqual(['刚压缩过，没有新的内容可交接'])
    expect(session.state()).toBe('idle')
  })
})
