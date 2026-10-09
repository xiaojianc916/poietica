import './omp-home'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentEngine, EngineSession, EngineSessionEvent, EngineToolSpec } from '@poietica/engine'
import { noopLogger } from '@poietica/foundation'
import { applyOps, emptyTimeline, pageFromState, type TranscriptPage } from '@poietica/transcript'
import { z } from 'zod'
import { testLayout } from './omp-home'

/*
 * 交互上屏（迁移自 legacy 的 interaction.test.ts 与 interaction-reaches-the-dock.test.ts）：
 * 经 OmpSession + omp mock provider 驱动，验的是**屏幕上看得到的那一条链** ——
 * omp 的审批闸门 → broker → interactionRequested + interaction.upsert → 答复 → resolved。
 */

const engines: AgentEngine[] = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose()
})

interface Harness {
  readonly session: EngineSession
  readonly events: EngineSessionEvent[]
  waitFor(predicate: (events: readonly EngineSessionEvent[]) => boolean, message: string): Promise<void>
}

function record(session: EngineSession): Harness {
  const events: EngineSessionEvent[] = []
  session.subscribe((event) => events.push(event))
  return {
    session,
    events,
    async waitFor(predicate, message) {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        if (predicate(events)) return
        await Bun.sleep(10)
      }
      throw new Error(`${message}：${events.map((e) => e.type).join(', ')}`)
    },
  }
}

function pageOf(events: readonly EngineSessionEvent[]): TranscriptPage {
  let state = emptyTimeline()
  for (const event of events) if (event.type === 'timeline') state = applyOps(state, event.ops)
  return pageFromState(state)
}

async function open(posterior: 'ask' | 'full-access' = 'ask') {
  const { createOmpEngineForTest } = await import('../testing')
  const handle = await createOmpEngineForTest({ layout: testLayout, logger: noopLogger, relayPort: 0 })
  engines.push(handle.engine)
  // write_test 是 write 级工具：ask 姿态下 omp 会发起审批
  const writeTest: EngineToolSpec<z.ZodObject<{ text: z.ZodString }>> = {
    name: 'write_test',
    label: '写入测试',
    description: 'Pretend to write a file.',
    parameters: z.object({ text: z.string() }),
    approval: 'write',
    execute: async (params) => ({ text: `wrote:${params.text}` }),
  }
  handle.engine.registerTool(writeTest)
  handle.engine.freezeTools()
  const cwd = await mkdtemp(path.join(tmpdir(), 'poietica-interaction-'))
  const session = await handle.engine.openSession({
    key: 'thread-1',
    cwd,
    sessionFile: null,
    posture: posterior,
    model: null,
    thinking: null,
  })
  return { handle, session }
}

const toolTurn = (name: string, text: string) => [[{ kind: 'tool' as const, name, args: { text }, result: '' }]]

describe('交互经 OmpSession 上屏', () => {
  test('审批请求到达 UI，卡片 pending；答复后卡片收口、轮子继续到 idle', async () => {
    const { handle, session } = await open('ask')
    handle.script(toolTurn('write_test', 'x'))
    const h = record(session)
    await session.submit({ text: 'go', images: [], files: [], skillNames: [], skills: [], deliverAs: 'turn' } as never)
    await h.waitFor((events) => events.some((e) => e.type === 'interactionRequested'), '没有得到审批请求')
    const requested = h.events.find((e) => e.type === 'interactionRequested')
    if (requested?.type !== 'interactionRequested') throw new Error('形状不对')
    expect(requested.interaction.kind).toBe('approval')
    // 卡片已经上屏（pending）
    const pageWhilePending = pageOf(h.events)
    expect(pageWhilePending.interactions.some((i) => i.state === 'pending')).toBe(true)
    expect(session.interactions().length).toBe(1)

    session.respond(requested.interaction.id, {
      kind: 'approval',
      decision: 'approve',
      scope: 'once',
      feedback: null,
    })
    await h.waitFor((events) => events.some((e) => e.type === 'state' && e.state === 'idle'), '答复后没有结束')
    expect(h.events.some((e) => e.type === 'interactionResolved')).toBe(true)
    const page = pageOf(h.events)
    expect(page.interactions.some((i) => i.state === 'approved')).toBe(true)
    // 工具真的执行了，结果落在时间线上
    const toolText = page.items.flatMap((item) =>
      item.kind === 'turn'
        ? item.steps.flatMap((s) => s.frames.flatMap((f) => (f.kind === 'tool' ? [String(f.state)] : [])))
        : [],
    )
    expect(toolText).toContain('done')
  })

  test('拒绝同样收口，卡片是 rejected', async () => {
    const { handle, session } = await open('ask')
    handle.script(toolTurn('write_test', 'x'))
    const h = record(session)
    await session.submit({ text: 'go', images: [], files: [], skills: [], deliverAs: 'turn' } as never)
    await h.waitFor((events) => events.some((e) => e.type === 'interactionRequested'), '没有得到审批请求')
    const requested = h.events.find((e) => e.type === 'interactionRequested')
    if (requested?.type !== 'interactionRequested') throw new Error('形状不对')
    session.respond(requested.interaction.id, {
      kind: 'approval',
      decision: 'reject',
      scope: 'once',
      feedback: null,
    })
    await h.waitFor((events) => events.some((e) => e.type === 'state' && e.state === 'idle'), '拒绝后没有结束')
    expect(pageOf(h.events).interactions.some((i) => i.state === 'rejected')).toBe(true)
  })

  test('full-access 姿态下同一个工具不发起审批', async () => {
    const { handle, session } = await open('full-access')
    handle.script(toolTurn('write_test', 'x'))
    const h = record(session)
    await session.submit({ text: 'go', images: [], files: [], skills: [], deliverAs: 'turn' } as never)
    await h.waitFor((events) => events.some((e) => e.type === 'state' && e.state === 'idle'), '这一轮没有结束')
    expect(h.events.some((e) => e.type === 'interactionRequested')).toBe(false)
  })

  test('对不存在的交互答复抛 engine.interaction_expired', async () => {
    const { session } = await open('ask')
    const error = (() => {
      try {
        session.respond('nope', { kind: 'dismiss' })
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(error).toBeDefined()
    expect(String((error as { code?: string }).code)).toBe('engine.interaction_expired')
  })
})
