import './omp-home'

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { EngineSession, EngineSessionEvent, OpenSessionSpec, SubmitInput } from '@poietica/engine'
import { AppError, noopLogger } from '@poietica/foundation'
import { applyOps, emptyTimeline, type TranscriptOperation } from '@poietica/transcript'
import { wrapOmpSession } from '../omp-session-adapter'

/*
 * 排队 / 插话这条链路的十条判据（R-01 §5.1）。
 *
 * 假的 omp AgentSession 有两个真数组当队列（steering / followUp）：`steer` / `followUp` /
 * `promptCustomMessage` 往数组里 push 并发一帧 queue_update；`removeQueuedMessage` 删第一个
 * 匹配、返回是否删到、同样发帧。测试自己用 `fold()` / `messageStart()` 放帧，模拟 omp 把
 * 队头折进上下文 —— queue_update 与 message_start 的先后顺序正是认领最容易出错的地方（Q7）。
 *
 * 被测对象是**真的适配器 + 真的 OmpSession**：这条链路的六个缺陷全都跨这两层。
 */
const NOW = 1_700_000_000_000

/** 技能展开要读真的 SKILL.md（omp 的 buildSkillPromptMessage 那条路），进程内建一次 */
const SKILL_DIR = path.join(tmpdir(), 'poietica-queue-fixture-skill')
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md')
if (!existsSync(SKILL_FILE)) {
  mkdirSync(SKILL_DIR, { recursive: true })
  writeFileSync(SKILL_FILE, '---\nname: review\ndescription: queue fixture skill\n---\n夹具技能正文。\n')
}

interface Call {
  readonly how: 'prompt' | 'customMessage' | 'steer' | 'followUp'
  readonly text: string
  readonly options?: Record<string, unknown>
}

interface Fixture {
  readonly session: EngineSession
  readonly events: EngineSessionEvent[]
  /** omp 此刻的两个队列，里面就是投递正文 */
  readonly steering: string[]
  readonly followUp: string[]
  readonly calls: Call[]
  /** 发一帧 queue_update（把两个队列当前的样子报出去） */
  syncQueue(): void
  /** 发一帧 message_start */
  messageStart(message: Record<string, unknown>): void
  /** 让下一次 followUp 投递挂住，直到 openFollowUpGate()（Q9 的慢投递） */
  installFollowUpGate(): void
  openFollowUpGate(): void
}

const BASE_SPEC: OpenSessionSpec = {
  key: 'queue',
  cwd: 'C:\\work',
  sessionFile: null,
  posture: 'ask',
  model: null,
  thinking: null,
}

async function fixture(): Promise<Fixture> {
  const listeners: ((event: Record<string, unknown>) => void)[] = []
  const steering: string[] = []
  const followUp: string[] = []
  const calls: Call[] = []
  let gate: Promise<void> | null = null
  let openGate: (() => void) | null = null

  const emitQueue = (): void => {
    for (const listener of listeners) {
      listener({ type: 'queue_update', steering: [...steering], followUp: [...followUp] })
    }
  }

  const agentSession = {
    sessionId: 'session-queue',
    sessionFile: 'session-queue.jsonl',
    settings: Settings.isolated(),
    messages: [],
    skills: [{ name: 'review', filePath: SKILL_FILE, baseDir: SKILL_DIR }],
    sessionManager: {
      getArtifactsDir: () => 'C:\\work\\artifacts',
      getSessionId: () => 'session-queue',
      getCwd: () => 'C:\\work',
    },
    subscribe(listener: (event: Record<string, unknown>) => void): () => void {
      listeners.push(listener)
      return () => undefined
    },
    prompt: async (text: string): Promise<boolean> => {
      calls.push({ how: 'prompt', text })
      return true
    },
    promptCustomMessage: async (
      message: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<boolean> => {
      // omp 把 queueChipText 写进 details.__queueChipText，getQueuedMessages 先读它
      const chip = typeof options?.queueChipText === 'string' ? options.queueChipText : ''
      calls.push({ how: 'customMessage', text: chip, ...(options === undefined ? {} : { options }) })
      if (options?.streamingBehavior === 'steer') steering.push(chip)
      else followUp.push(chip)
      emitQueue()
      void message
      return true
    },
    steer: async (text: string): Promise<void> => {
      calls.push({ how: 'steer', text })
      steering.push(text)
      emitQueue()
    },
    followUp: async (text: string): Promise<void> => {
      const held = gate
      if (held !== null) {
        gate = null
        await held
      }
      calls.push({ how: 'followUp', text })
      followUp.push(text)
      emitQueue()
    },
    abort: async (): Promise<void> => undefined,
    dispose: async (): Promise<void> => undefined,
    setPromptDropped: (): void => undefined,
    setThinkingLevel: (): void => undefined,
    setSteeringMode: (): void => undefined,
    setFollowUpMode: (): void => undefined,
    getQueuedMessages: () => ({ steering: [...steering], followUp: [...followUp] }),
    removeQueuedMessage: (text: string, queue: 'steering' | 'followUp'): boolean => {
      const target = queue === 'steering' ? steering : followUp
      const at = target.indexOf(text)
      if (at < 0) return false
      target.splice(at, 1)
      emitQueue()
      return true
    },
    getContextUsage: () => undefined,
    getLastAssistantMessage: () => undefined,
    getAvailableThinkingLevels: () => [],
  }

  const session = await wrapOmpSession({
    spec: BASE_SPEC,
    settings: agentSession.settings,
    agentSession,
    setToolUIContext: () => undefined,
    mcpManager: null,
    tools: new Map(),
    logger: noopLogger,
    subagentBus: null,
    initializeExtensions: async () => undefined,
    modelCatalog: () => null,
    model: null,
    thinking: null,
  })
  const events: EngineSessionEvent[] = []
  session.subscribe((event) => events.push(event))

  return {
    session,
    events,
    steering,
    followUp,
    calls,
    syncQueue: emitQueue,
    messageStart: (message) => {
      for (const listener of listeners) listener({ type: 'message_start', message })
    },
    installFollowUpGate: () => {
      let open!: () => void
      gate = new Promise<void>((resolve) => {
        open = resolve
      })
      openGate = open
    },
    openFollowUpGate: () => {
      openGate?.()
    },
  }
}

function submit(text: string, deliverAs: 'turn' | 'steer' | 'followUp' = 'turn', over: Partial<SubmitInput> = {}) {
  return { text, images: [], files: [], skills: [], deliverAs, ...over } satisfies SubmitInput
}

/** 时间线上全部文本帧的 (role, text)，按到达顺序 */
function textFrames(events: readonly EngineSessionEvent[]): { readonly role: string; readonly text: string }[] {
  const ops: TranscriptOperation[] = events.flatMap((event) => (event.type === 'timeline' ? event.ops : []))
  const state = applyOps(emptyTimeline(), ops)
  const frames: { role: string; text: string }[] = []
  for (const item of state.items) {
    if (item.kind !== 'turn') continue
    for (const step of item.steps)
      for (const frame of step.frames) if (frame.kind === 'text') frames.push({ role: frame.role, text: frame.text })
  }
  return frames
}

function textsOf(frames: readonly { readonly role: string; readonly text: string }[], text: string): number {
  return frames.filter((frame) => frame.text === text).length
}

describe('排队 / 插话链路（R-01 §5.1）', () => {
  test('Q1 忙时的 followUp 带上文件：omp 收到的正文 = 原文 + @路径', async () => {
    const f = await fixture()
    await f.session.submit(submit('打底'))
    f.calls.length = 0

    await f.session.submit(submit('看这个文件', 'followUp', { files: [{ path: 'C:\\a.txt', name: 'a.txt' }] }))

    expect(f.calls.find((call) => call.how === 'followUp')?.text).toBe('看这个文件\n@C:\\a.txt')
    await f.session.cancel()
  })

  /*
   * 投递正文与显示正文是两件事（R-01 §3.1 第 2 条）：omp 报回来的队列正文与 message_start
   * 都是带 `@路径` 的那一份（与 omp 的一切匹配认它），而**屏幕上画的是用户原文**。
   * 这一条同时钉住「普通 steer 的 message_start 正文等于 prepared.text」这个实测结论。
   */
  test('Q1b 带文件的插话：按投递正文认领，画出来的是用户原文', async () => {
    const f = await fixture()
    await f.session.submit(submit('打底'))
    await f.session.submit(submit('看这个文件', 'steer', { files: [{ path: 'C:\\a.txt', name: 'a.txt' }] }))

    expect(f.steering).toEqual(['看这个文件\n@C:\\a.txt'])
    const item = f.session.queue().items.find((entry) => entry.text === '看这个文件')!
    expect(f.session.queue().items.find((entry) => entry.id === item.id)?.text).toBe('看这个文件')

    f.steering.splice(f.steering.indexOf('看这个文件\n@C:\\a.txt'), 1)
    f.syncQueue()
    f.messageStart({ role: 'user', content: '看这个文件\n@C:\\a.txt', timestamp: NOW + 1 })

    expect(textFrames(f.events).filter((frame) => frame.role === 'user' && frame.text === '看这个文件')).toHaveLength(1)
    expect(textFrames(f.events).some((frame) => frame.text.includes('@C:\\a.txt'))).toBe(false)
    await f.session.cancel()
  })

  test('Q2 撤回中间那条：其余项原地不动，账本的 id 也不变', async () => {
    const f = await fixture()
    await f.session.submit(submit('打底'))
    await f.session.submit(submit('S1', 'steer'))
    await f.session.submit(submit('F1', 'followUp'))
    await f.session.submit(submit('F2', 'followUp'))

    const before = f.session.queue().items
    const target = before.find((item) => item.text === 'F1')!
    f.session.withdraw(target.id)

    expect(f.steering).toEqual(['S1'])
    expect(f.followUp).toEqual(['F2'])
    const after = f.session.queue().items
    expect(after.map((item) => item.text)).toEqual(['S1', 'F2'])
    for (const item of after) {
      expect(before.find((entry) => entry.id === item.id)?.text).toBe(item.text)
    }
    await f.session.cancel()
  })

  test('Q3 撤回最后一条 steer 时不动 followUp', async () => {
    const f = await fixture()
    await f.session.submit(submit('打底'))
    await f.session.submit(submit('S1', 'steer'))
    await f.session.submit(submit('F1', 'followUp'))

    const item = f.session.queue().items.find((entry) => entry.text === 'S1')!
    f.session.withdraw(item.id)

    expect(f.steering).toEqual([])
    expect(f.followUp).toEqual(['F1'])
    await f.session.cancel()
  })

  test('Q4 带技能的 followUp 换到 steer：走 promptCustomMessage，streamingBehavior 是 steer', async () => {
    const f = await fixture()
    await f.session.submit(submit('打底'))
    await f.session.submit(submit('带技能的一句', 'followUp', { skills: ['review'] }))
    f.calls.length = 0

    const item = f.session.queue().items.find((entry) => entry.text === '带技能的一句')!
    await f.session.moveQueued(item.id, 'steer')

    expect(f.calls.map((call) => call.how)).toEqual(['customMessage'])
    expect(f.calls[0]?.options?.streamingBehavior).toBe('steer')
    expect(f.steering).toEqual(['带技能的一句'])
    expect(f.followUp).toEqual([])
    await f.session.cancel()
  })

  test('Q5 撤回再作为新一轮发出：同一句话只画一次', async () => {
    const f = await fixture()
    await f.session.submit(submit('打底'))
    await f.session.submit(submit('X', 'followUp'))
    const item = f.session.queue().items.find((entry) => entry.text === 'X')!
    f.session.withdraw(item.id)
    await f.session.cancel()

    await f.session.submit(submit('X'))
    f.messageStart({ role: 'user', content: 'X', timestamp: NOW + 2 })

    expect(textsOf(textFrames(f.events), 'X')).toBe(1)
    await f.session.cancel()
  })

  test('Q6 带技能的插话折进上下文后画出 user 帧', async () => {
    const f = await fixture()
    await f.session.submit(submit('打底'))
    await f.session.submit(submit('带技能的一句', 'steer', { skills: ['review'] }))
    const item = f.session.queue().items.find((entry) => entry.text === '带技能的一句')!
    expect(item.deliverAs).toBe('steer')

    // omp 把这条折进上下文：队列里拿掉它，然后发 custom 的 message_start
    f.steering.splice(f.steering.indexOf('带技能的一句'), 1)
    f.syncQueue()
    f.messageStart({ role: 'custom', customType: 'skill-prompt', attribution: 'user', content: '技能正文' })

    const frames = textFrames(f.events).filter((frame) => frame.text === '带技能的一句')
    expect(frames).toHaveLength(1)
    expect(frames[0]?.role).toBe('user')
    await f.session.cancel()
  })

  test('Q7 queue_update 与 message_start 的两种顺序都只画一次', async () => {
    for (const queueFirst of [true, false]) {
      const f = await fixture()
      await f.session.submit(submit('打底'))
      await f.session.submit(submit('一句steer', 'steer'))
      const item = f.session.queue().items.find((entry) => entry.text === '一句steer')!
      f.steering.splice(f.steering.indexOf('一句steer'), 1)
      if (queueFirst) f.syncQueue()
      f.messageStart({ role: 'user', content: '一句steer', timestamp: NOW + 1 })
      if (!queueFirst) f.syncQueue()
      f.syncQueue()

      expect(textsOf(textFrames(f.events), '一句steer')).toBe(1)
      expect(f.session.queue().items.some((entry) => entry.id === item.id)).toBe(false)
      await f.session.cancel()
    }
  })

  test('Q8 撤回一条 omp 已经取走的项：抛 engine.queue_item_consumed，它仍然会上屏一次', async () => {
    const f = await fixture()
    await f.session.submit(submit('打底'))
    await f.session.submit(submit('已经取走', 'steer'))
    const item = f.session.queue().items.find((entry) => entry.text === '已经取走')!
    // omp 已经把它取走，但 queue_update 还没到：账本里还留着，removeQueuedMessage 返回 false
    f.steering.splice(f.steering.indexOf('已经取走'), 1)

    let error: unknown
    try {
      f.session.withdraw(item.id)
    } catch (cause) {
      error = cause
    }
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('engine.queue_item_consumed')

    f.messageStart({ role: 'user', content: '已经取走', timestamp: NOW + 1 })
    expect(textsOf(textFrames(f.events), '已经取走')).toBe(1)
    await f.session.cancel()
  })

  test('Q9 第一条投递慢时，顺序仍然按提交先后落账与落队', async () => {
    const f = await fixture()
    await f.session.submit(submit('打底'))
    f.calls.length = 0

    f.installFollowUpGate()
    const first = f.session.submit(submit('第一条', 'followUp'))
    const second = f.session.submit(submit('第二条', 'followUp'))
    // 第一条挂在投递里：第二条必须等它，账本此刻应是空的
    await Bun.sleep(10)
    expect(f.session.queue().items).toEqual([])

    f.openFollowUpGate()
    await first
    await second

    expect(f.session.queue().items.map((item) => item.text)).toEqual(['第一条', '第二条'])
    expect(f.followUp).toEqual(['第一条', '第二条'])
    await f.session.cancel()
  })

  test('Q10 abort 之后再发同文的一句：只画一次', async () => {
    const f = await fixture()
    await f.session.submit(submit('打底'))
    await f.session.submit(submit('丢弃的一句', 'followUp'))
    await f.session.cancel()
    // abort 把 omp 的队列丢了：对账之后账本也清空
    f.followUp.length = 0
    f.syncQueue()

    await f.session.submit(submit('丢弃的一句'))
    f.messageStart({ role: 'user', content: '丢弃的一句', timestamp: NOW + 3 })

    expect(textsOf(textFrames(f.events), '丢弃的一句')).toBe(1)
    await f.session.cancel()
  })
})
