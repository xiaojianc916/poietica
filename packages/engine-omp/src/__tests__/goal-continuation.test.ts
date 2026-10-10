import './omp-home'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentEngine, EngineSession, EngineSessionEvent, EngineToolSpec } from '@poietica/engine'
import type { ScenarioStep } from '@poietica/engine-testkit'
import { noopLogger } from '@poietica/foundation'
import type { TranscriptOperation } from '@poietica/transcript'
import { z } from 'zod'
import type { MockEngineHandle } from '../testing'
import { testLayout } from './omp-home'

/*
 * 目标模式的宿主职责（审查 R-11）：omp 真 SDK + mock provider，验人看得到的那几件事 ——
 * 两轮之间自动续跑、暂停 / 停止真的停、重开会话目标还在、完成之后收尾。
 *
 * 续跑何时停由 omp 的 RpcGoalController 决定：一轮续跑里没有新的工具调用（goalContinuationActivity
 * 为空）就停下等人。所以脚本里「要它继续」的续跑轮都带一次工具调用，最后一轮只回正文。
 * 第一轮（人的那一句）不论有没有工具调用都会接着续跑。
 */

const engines: AgentEngine[] = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose()
})

/* 故意写死字面量、不导入生产常量：常量写错时这里要能抓住 */
const CONTINUATION_ORIGIN = { kind: 'other', payload: { kind: 'system_trigger', name: 'goal_continuation' } } as const

/** 能卡住的工具：execute 进门就报到，等测试放行（或被 abort）才返回 */
interface Gate {
  readonly entered: Promise<void>
  release(): void
}

interface GateTool {
  readonly spec: EngineToolSpec<z.ZodObject<Record<string, never>>>
  next(): Gate
}

function gateTool(): GateTool {
  let slot: { readonly entered: () => void; readonly released: Promise<void> } | null = null
  return {
    next() {
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      slot = { entered: () => entered.resolve(), released: released.promise }
      return { entered: entered.promise, release: () => released.resolve() }
    },
    spec: {
      name: 'gate_test',
      label: '闸门测试',
      description: 'Wait until the test releases it.',
      parameters: z.object({}),
      approval: 'read',
      execute: async (_params, ctx) => {
        const current = slot
        if (current === null) return { text: 'no gate' }
        current.entered()
        const aborted = new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()))
        await Promise.race([current.released, aborted])
        return { text: 'gate passed' }
      },
    },
  }
}

interface Rig {
  readonly handle: MockEngineHandle
  readonly gate: GateTool
}

interface Harness extends Rig {
  readonly session: EngineSession
  readonly events: EngineSessionEvent[]
  waitFor(predicate: () => boolean, message: string): Promise<void>
  reopen(): Promise<Harness>
}

async function rig(): Promise<Rig> {
  const { createOmpEngineForTest } = await import('../testing')
  const handle = await createOmpEngineForTest({ layout: testLayout, logger: noopLogger, relayPort: 0 })
  engines.push(handle.engine)
  const gate = gateTool()
  const writeTest: EngineToolSpec<z.ZodObject<{ text: z.ZodString }>> = {
    name: 'write_test',
    label: '写入测试',
    description: 'Pretend to write a file.',
    parameters: z.object({ text: z.string() }),
    approval: 'write',
    execute: async (params) => ({ text: `wrote:${params.text}` }),
  }
  handle.engine.registerTool(writeTest)
  handle.engine.registerTool(gate.spec)
  handle.engine.freezeTools()
  return { handle, gate }
}

async function open(input?: { rig?: Rig; cwd?: string; sessionFile?: string }): Promise<Harness> {
  const r = input?.rig ?? (await rig())
  const cwd = input?.cwd ?? (await mkdtemp(path.join(tmpdir(), 'poietica-goal-')))
  const session = await r.handle.engine.openSession({
    key: `goal-${crypto.randomUUID()}`,
    cwd,
    sessionFile: input?.sessionFile ?? null,
    posture: 'full-access',
    model: null,
    thinking: null,
  })
  const events: EngineSessionEvent[] = []
  session.subscribe((event) => events.push(event))
  return {
    ...r,
    session,
    events,
    async waitFor(predicate, message) {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (predicate()) return
        await Bun.sleep(10)
      }
      throw new Error(`${message}：${events.map((e) => (e.type === 'state' ? `state:${e.state}` : e.type)).join(', ')}`)
    },
    async reopen() {
      const file = session.sessionFile
      await session.dispose()
      return await open({ rig: r, cwd, sessionFile: file })
    },
  }
}

type TurnHeader = Extract<TranscriptOperation, { op: 'turn.upsert' }>['turn']

/** 每一轮最后一份轮头（turn.upsert 是整头替换，最后一份就是屏幕上的样子） */
function turnsOf(events: readonly EngineSessionEvent[]): TurnHeader[] {
  const turns = new Map<string, TurnHeader>()
  for (const event of events) {
    if (event.type !== 'timeline') continue
    for (const op of event.ops) if (op.op === 'turn.upsert') turns.set(op.turn.turnId, op.turn)
  }
  return [...turns.values()]
}

function statesOf(events: readonly EngineSessionEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'state' ? [event.state] : []))
}

const say = (text: string): ScenarioStep[] => [{ kind: 'text', text }]
const work = (text: string): ScenarioStep[] => [
  { kind: 'tool', name: 'write_test', args: { text }, result: '' },
  { kind: 'text', text },
]
const wait = (text: string): ScenarioStep[] => [
  { kind: 'tool', name: 'gate_test', args: {}, result: '' },
  { kind: 'text', text },
]

const send = (h: Harness, text: string) =>
  h.session.submit({ text, images: [], files: [], skills: [], deliverAs: 'turn' })

/** 设目标 + 发一句：与 UI「目标开关 + 发送」同一个次序（session-port.prompt：先 setGoal 再 submit） */
async function startGoal(h: Harness, objective: string): Promise<void> {
  await h.session.setGoal(objective)
  await send(h, objective)
}

function settled(h: Harness, turns: number): () => boolean {
  return () => h.session.state() === 'idle' && turnsOf(h.events).length >= turns && statesOf(h.events).at(-1) === 'idle'
}

describe('续跑（R-11）', () => {
  test('C1 两轮之间自动续跑：续跑轮上屏、不带人话；状态全程 running，最后只报一次 idle', async () => {
    const h = await open()
    h.handle.script([say('第一轮'), work('第二轮'), say('第三轮')])
    await startGoal(h, '把测试迁完')
    await h.waitFor(settled(h, 3), '没有跑完三轮')
    await Bun.sleep(200)
    const turns = turnsOf(h.events)
    expect(turns).toHaveLength(3)
    expect(turns[0]).toMatchObject({ origin: { kind: 'user' }, prompt: '把测试迁完', state: 'completed' })
    for (const turn of turns.slice(1)) {
      expect(turn.origin).toEqual(CONTINUATION_ORIGIN)
      expect(turn.prompt).toBeUndefined()
      expect(turn.state).toBe('completed')
    }
    expect(statesOf(h.events).filter((state) => state === 'idle')).toHaveLength(1)
    expect(h.session.controls().goalSnapshot?.status).toBe('active')
  }, 20_000)

  test('C2 建目标不抢第一轮：设好目标、人还没发话时什么都不跑；第一轮是人的那一句', async () => {
    const h = await open()
    h.handle.script([say('人的那一轮'), say('续跑')])
    await h.session.setGoal('整理文档')
    await Bun.sleep(150)
    expect(turnsOf(h.events)).toHaveLength(0)
    expect(h.session.state()).toBe('idle')
    await send(h, '整理文档')
    await h.waitFor(settled(h, 2), '没有跑完两轮')
    const turns = turnsOf(h.events)
    expect(turns[0]).toMatchObject({ origin: { kind: 'user' }, prompt: '整理文档' })
    expect(turns[1]?.origin).toEqual(CONTINUATION_ORIGIN)
  }, 20_000)

  test('C3 暂停：当前这一轮跑完（completed），之后不再续跑', async () => {
    const h = await open()
    const gate = h.gate.next()
    h.handle.script([wait('跑完了'), say('不该出现')])
    await startGoal(h, '跑一个长任务')
    await gate.entered
    await h.session.pauseGoal()
    gate.release()
    await h.waitFor(settled(h, 1), '暂停之后没有收成 idle')
    await Bun.sleep(300)
    expect(turnsOf(h.events)).toHaveLength(1)
    expect(turnsOf(h.events)[0]?.state).toBe('completed')
    expect(h.session.controls().goalSnapshot?.status).toBe('paused')
  }, 20_000)

  test('C4 停止：续跑那一轮被中断，会话回到 idle，目标变成已暂停，不再续跑', async () => {
    const h = await open()
    const gate = h.gate.next()
    h.handle.script([say('第一轮'), wait('不该出现')])
    await startGoal(h, '跑一个长任务')
    await gate.entered
    await h.session.cancel()
    await h.waitFor(() => h.session.state() === 'idle', '停止之后没有回到 idle')
    await Bun.sleep(300)
    expect(h.session.state()).toBe('idle')
    expect(turnsOf(h.events)).toHaveLength(2)
    expect(h.session.controls().goalSnapshot?.status).toBe('paused')
  }, 20_000)
})

/**
 * 先聊一句（不带目标）再设目标：omp 的会话文件在第一轮之后才落盘（omp 知识 #14），没聊过的会话重开不了；
 * 设目标时会话正空闲且「刚建好、还没跑过一轮」，所以不会续跑 —— 会话文件里留下的就是一个进行中的目标。
 */
async function chatted(): Promise<Harness> {
  const h = await open()
  h.handle.script([say('好的')])
  await send(h, '先聊一句')
  await h.waitFor(settled(h, 1), '第一轮没有跑完')
  return h
}

describe('重开与收尾（R-11）', () => {
  test('R1 重开会话：进行中的目标以「已暂停」接回', async () => {
    const h = await chatted()
    await h.session.setGoal('迁移数据库')
    const again = await h.reopen()
    expect(again.session.controls().goalSnapshot).toMatchObject({ objective: '迁移数据库', status: 'paused' })
  }, 20_000)

  test('R2 重开后按「继续」：立刻续跑一轮，不用再说话', async () => {
    const h = await chatted()
    await h.session.setGoal('迁移数据库')
    const again = await h.reopen()
    again.handle.script([say('接着干')])
    await again.session.resumeGoal()
    expect(again.session.state()).toBe('running')
    await again.waitFor(settled(again, 1), '继续之后没有续跑')
    expect(turnsOf(again.events)).toHaveLength(1)
    expect(turnsOf(again.events)[0]?.origin).toEqual(CONTINUATION_ORIGIN)
  }, 20_000)

  test('R3 完成：收尾写进会话文件、目标清掉；重开之后没有目标', async () => {
    const h = await open()
    h.handle.script([
      [
        { kind: 'tool', name: 'goal', args: { op: 'complete' }, result: '' },
        { kind: 'text', text: '完成' },
      ],
    ])
    await startGoal(h, '一次就完')
    await h.waitFor(settled(h, 1), '没有跑完')
    await Bun.sleep(100)
    expect(h.session.controls().goalSnapshot).toBeNull()
    expect(await readFile(h.session.sessionFile, 'utf8')).toContain('goal-completed')
    const again = await h.reopen()
    expect(again.session.controls().goalSnapshot).toBeNull()
  }, 20_000)

  test('R4 重开后的历史与刚才的时间线一致：轮数、来源、人话', async () => {
    const h = await open()
    h.handle.script([say('第一轮'), work('第二轮'), say('第三轮')])
    await startGoal(h, '把测试迁完')
    await h.waitFor(settled(h, 3), '没有跑完三轮')
    const live = turnsOf(h.events).map((turn) => ({ origin: turn.origin, prompt: turn.prompt }))
    const again = await h.reopen()
    const page = await again.session.page('main', null)
    const history = page.items.flatMap((item) =>
      item.kind === 'turn' ? [{ origin: item.origin, prompt: item.prompt }] : [],
    )
    expect(history).toEqual(live)
  }, 20_000)
})
