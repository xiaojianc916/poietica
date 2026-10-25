import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EngineSessionEvent, EngineToolSpec } from '@poietica/engine'
import type { ScenarioStep } from '@poietica/engine-testkit'
import { noopLogger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import { applyOps, emptyTimeline, pageFromState, type TranscriptFrame, type TranscriptPage } from '@poietica/transcript'
import { z } from 'zod'
import { createOmpEngineForTest } from '../testing'
import { testLayout } from './omp-home'

/*
 * 增量那条路（LiveProjector）与历史那条路（projectHistoryPage）对**同一段真实 omp 会话**
 * 必须给出同一张屏 —— 两条路各有一堆逐例测试，但「跑的时候一个样、重开之后另一个样」
 * （R-10 / R-12 / R-19 / R-21 / R-23 / R-25）从来没人把两边摆在一起比。这里用真 omp 跑一遍，
 * 比三张页：live、当场取的历史页、重开后的历史页。比的是界面真正用到的：每帧的种类 / 角色 /
 * 正文 / 工具名与状态，**以及帧号**（界面按帧号记量高缓存与展开状态，号错了状态错位到别的行）；
 * 段的划分两边不同，界面把段摊平了用，这里也摊平了比。
 */

interface FlatFrame {
  readonly kind: string
  readonly id: string
  readonly role?: string
  readonly origin?: string
  readonly text?: string
  readonly tool?: string
}

function flatFrame(frame: TranscriptFrame): FlatFrame {
  switch (frame.kind) {
    case 'tool':
      return { kind: 'tool', id: frame.frameId, tool: `${frame.name}:${frame.state}` }
    case 'thinking':
      return { kind: 'thinking', id: frame.frameId, text: frame.text }
    case 'text':
      return frame.role === 'user'
        ? { kind: 'text', id: frame.frameId, role: 'user', text: frame.text, origin: frame.origin?.kind ?? 'none' }
        : { kind: 'text', id: frame.frameId, role: frame.role, text: frame.text }
    default:
      return { kind: frame.kind, id: frame.frameId }
  }
}

interface FlatRow {
  readonly kind?: string
  readonly turn?: string
  readonly prompt?: string
  readonly state?: string
  readonly frames?: readonly FlatFrame[]
}

function flatten(page: TranscriptPage): FlatRow[] {
  return page.items.map((item) => {
    if (item.kind !== 'turn') return { kind: item.kind }
    const frames = item.steps.flatMap((step) => step.frames.map(flatFrame))
    return { turn: item.turnId, prompt: item.prompt, state: item.state, frames }
  })
}

const echo: EngineToolSpec<z.ZodObject<{ text: z.ZodString }>> = {
  name: 'echo_test',
  label: 'echo',
  description: 'echo',
  parameters: z.object({ text: z.string() }),
  approval: 'read',
  execute: async (args) => ({ text: `echo:${args.text}` }),
}

async function threePages(turns: readonly (readonly ScenarioStep[])[]) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'poietica-parity-'))
  const handle = await createOmpEngineForTest({ layout: testLayout as DataLayout, logger: noopLogger, relayPort: 0 })
  handle.engine.registerTool(echo)
  await handle.engine.freezeTools()
  const open = (sessionFile: string | null) =>
    handle.engine.openSession({ key: 'parity', cwd, sessionFile, posture: 'full-access', model: null, thinking: null })
  const session = await open(null)
  const events: EngineSessionEvent[] = []
  session.subscribe((event) => events.push(event))
  const idles = () => events.filter((event) => event.type === 'state' && event.state === 'idle').length
  for (const [index, steps] of turns.entries()) {
    handle.script([steps])
    await session.submit({ text: `第 ${String(index + 1)} 句`, images: [], files: [], skills: [], deliverAs: 'turn' })
    const deadline = Date.now() + 5000
    while (idles() < index + 1) {
      if (Date.now() > deadline) throw new Error('等不到这一轮收尾')
      await Bun.sleep(5)
    }
  }
  await Bun.sleep(50)
  let state = emptyTimeline()
  for (const event of events) if (event.type === 'timeline') state = applyOps(state, event.ops)
  const live = pageFromState(state)
  const history = await session.page('main', null)
  const file = session.sessionFile
  await session.dispose()
  const again = await open(file)
  const reopened = await again.page('main', null)
  await again.dispose()
  await handle.engine.dispose()
  return { live: flatten(live), history: flatten(history), reopened: flatten(reopened) }
}

const tool = (text: string): ScenarioStep => ({ kind: 'tool', name: 'echo_test', args: { text }, result: '' })

const SCENARIOS: Record<string, readonly (readonly ScenarioStep[])[]> = {
  一段正文: [[{ kind: 'text', text: '你好' }]],
  思维链加正文: [
    [
      { kind: 'thinking', text: '想一想' },
      { kind: 'text', text: '想好了' },
    ],
  ],
  两次工具再收尾: [[tool('x'), tool('y'), { kind: 'text', text: '做完了' }]],
  两轮: [
    [{ kind: 'text', text: '第一轮' }],
    [
      { kind: 'thinking', text: '再想想' },
      { kind: 'text', text: '第二轮' },
    ],
  ],
}

describe('增量与历史两条投影对同一段真实会话同形（帧号也一样）', () => {
  for (const [name, turns] of Object.entries(SCENARIOS)) {
    test(
      name,
      async () => {
        const { live, history, reopened } = await threePages(turns)
        expect(history).toEqual(live)
        expect(reopened).toEqual(live)
      },
      20_000,
    )
  }

  test('开轮那句人话只在轮头：屏幕上没有来源不明（没有 origin）的用户帧', async () => {
    const { live } = await threePages([[{ kind: 'text', text: '一' }], [{ kind: 'text', text: '二' }]])
    const frames = live.flatMap((turn) => turn.frames ?? [])
    expect(frames.filter((frame) => frame.role === 'user' && frame.origin === 'none')).toEqual([])
  }, 20_000)
})
