import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  type AgentEngine,
  EngineErrorCode,
  type EngineSession,
  type EngineSessionEvent,
  type EngineToolSpec,
  type Interaction,
  type ModelRef,
} from '@poietica/engine'
import { AppError, type Disposable } from '@poietica/foundation'
import { applyOps, emptyTimeline, pageFromState, type TranscriptPage } from '@poietica/transcript'
import { z } from 'zod'
import type { ScenarioStep } from './scenario'

export interface ConformanceTarget {
  /**
   * 「到现在为止开过几个会话」——只读性的判据（C-DRAFT-CONTROLS 要证明 draftControls
   * 一条都不开）。
   *
   * 它是**可选**的：`AgentEngine` 本身没有这一格（真实引擎不需要对外报这个数），
   * 只有测试替身（FakeEngine 的 `opened`）拿得出来。缺席时那一条断言跳过 ——
   * 套件在真引擎上仍然要能跑。
   */
  readonly openedCount?: () => number
  /**
   * 模型引用 → 草稿表里 current 的那个写法（provider/id）。
   *
   * 同样可选：别名拼法是**测试侧**的事（避免在两个引擎的用例里各写一遍字符串拼接），
   * 不是引擎接口的一部分。
   */
  readonly draftAliasOf?: (model: ModelRef | null) => string | null
  readonly engine: AgentEngine
  /** 设定接下来几轮的回复；每次调用覆盖之前的设定 */
  script(turns: readonly (readonly ScenarioStep[])[]): void
  /** 一个可写的临时工作区目录 */
  readonly cwd: string
  dispose(): Promise<void>
}

interface Recorded {
  readonly events: EngineSessionEvent[]
  waitFor(predicate: (events: readonly EngineSessionEvent[]) => boolean, message?: string): Promise<void>
  readonly subscription: Disposable
}

function recorder(session: EngineSession): Recorded {
  const events: EngineSessionEvent[] = []
  const subscription = session.subscribe((event) => events.push(event))
  return {
    events,
    subscription,
    async waitFor(predicate, message = '等待事件超时') {
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline) {
        if (predicate(events)) return
        await Bun.sleep(5)
      }
      throw new Error(`${message}：已收到 ${events.map(describeEvent).join(', ')}`)
    },
  }
}

/** 出现过的交互 id（按出现顺序） */
function interactionIds(events: readonly EngineSessionEvent[]): string[] {
  return events
    .filter(
      (e): e is Extract<EngineSessionEvent, { type: 'interactionRequested' }> => e.type === 'interactionRequested',
    )
    .map((e) => e.interaction.id)
}

/** 第一个还没被答复的交互 id（用于逐轮应答审批） */
function pendingInteractionId(events: readonly EngineSessionEvent[], answered: ReadonlySet<string>): string | null {
  return interactionIds(events).find((id) => !answered.has(id)) ?? null
}

function describeEvent(event: EngineSessionEvent): string {
  return event.type === 'state' ? `state:${event.state}` : event.type
}

/** 事件类型序列（state 带上状态名，便于断言顺序） */
function shape(events: readonly EngineSessionEvent[]): string[] {
  return events.map(describeEvent)
}

function timelineOps(events: readonly EngineSessionEvent[]): ReturnType<typeof applyOps> {
  let state = emptyTimeline()
  for (const event of events) if (event.type === 'timeline') state = applyOps(state, event.ops)
  return state
}

function timelinePage(events: readonly EngineSessionEvent[]): TranscriptPage {
  return pageFromState(timelineOps(events))
}

function allText(page: TranscriptPage): string {
  const parts: string[] = []
  for (const item of page.items) {
    if (item.kind !== 'turn') continue
    // 用户文本在两种引擎里的落点不同：FakeEngine 放在 turn.prompt，OmpEngine 还会额外建一个用户帧
    if (item.prompt !== undefined) parts.push(item.prompt)
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'text' || frame.kind === 'thinking') parts.push(frame.text)
        // 工具产出按 UI 的读法取文本：omp 给的是 { content, details }，content 又是块数组
        if (frame.kind === 'tool') parts.push(toolTextOf(frame.output))
      }
    }
  }
  return parts.join('\n')
}

/** 工具产出的文本（与 UI 同一条规则：{ content, details } → content 里的文本块） */
function toolTextOf(output: unknown): string {
  const content = (output as { readonly content?: unknown } | null)?.content ?? output
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as readonly { readonly type?: unknown; readonly text?: unknown }[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

function turnCount(page: TranscriptPage): number {
  return page.items.filter((item) => item.kind === 'turn').length
}

/**
 * 端口语义的可执行定义：同一套用例同时跑在 FakeEngine 与真实的 OmpEngine 上（12 页 §1.3）。
 * make() 必须返回**尚未冻结工具表**的引擎；套件注册完两个测试工具后自己冻结。
 */
export function runEngineConformance(name: string, make: () => Promise<ConformanceTarget>): void {
  describe(`引擎一致性：${name}`, () => {
    let target: ConformanceTarget
    let echo: { calls: unknown[] }
    let writeCalls: { count: number }
    let answered: Set<string>

    beforeEach(async () => {
      target = await make()
      echo = { calls: [] }
      writeCalls = { count: 0 }
      answered = new Set<string>()
      target.engine.registerTool(echoTool(echo))
      target.engine.registerTool(writeTool(writeCalls))
      target.engine.freezeTools()
    })

    afterEach(async () => {
      await target.dispose()
    })

    const openNew = async (posture: 'ask' | 'full-access' = 'ask') =>
      await target.engine.openSession({
        key: 'conformance',
        cwd: target.cwd,
        sessionFile: null,
        posture,
        model: null,
        thinking: null,
      })

    test('C-OPEN-NEW', async () => {
      const session = await openNew()
      expect(session.sessionId.length).toBeGreaterThan(0)
      expect(session.state()).toBe('idle')
      expect(session.queue().items).toEqual([])
      expect(session.interactions()).toEqual([])
    })

    test('C-SUBMIT-TURN', async () => {
      const session = await openNew()
      const record = recorder(session)
      await session.submit(submit('hello'))
      await record.waitFor((events) => shape(events).includes('state:idle'), '这一轮没有结束')
      const states = record.events.filter((e) => e.type === 'state').map(describeEvent)
      // 12 页 §7.4：turn.upsert 的 timeline 先发，随后才是 state:running
      expect(states[0]).toBe('state:running')
      expect(states[states.length - 1]).toBe('state:idle')
      expect(shape(record.events)).toContain('timeline')
      const page = timelinePage(record.events)
      expect(turnCount(page)).toBe(1)
      expect(allText(page)).toContain('hello')
      expect(allText(page)).toContain('ok')
      record.subscription.dispose()
    })

    test('C-SUBMIT-RETURNS-EARLY', async () => {
      const session = await openNew()
      const record = recorder(session)
      target.script([[{ kind: 'interaction', interaction: { kind: 'confirm', title: '停一下', message: '继续？' } }]])
      const entered = Date.now()
      await session.submit(submit('first'))
      // submit 必须在这一轮还在跑的时候就返回
      expect(Date.now() - entered).toBeLessThan(2_000)
      expect(session.state()).not.toBe('idle')
      await record.waitFor((events) => events.some((e) => e.type === 'interactionRequested'), '没有等到交互')
      await session.cancel()
      record.subscription.dispose()
    })

    test('C-CANCEL', async () => {
      const session = await openNew()
      const record = recorder(session)
      target.script([
        [
          { kind: 'tool', name: 'write_test', args: { text: 'x' }, result: '' },
          { kind: 'interaction', interaction: { kind: 'confirm', title: '停一下', message: '继续？' } },
        ],
      ])
      await session.submit(submit('go'))
      await record.waitFor((events) => events.some((e) => e.type === 'interactionRequested'), '没有等到交互')
      await session.cancel()
      await record.waitFor((events) => shape(events).includes('state:idle'), '取消后没有回到 idle')
      expect(session.interactions()).toEqual([])
      expect(shape(record.events)).toContain('interactionResolved')
      record.subscription.dispose()
    })

    test('C-INTERACTION', async () => {
      const session = await openNew('ask')
      const record = recorder(session)
      target.script([[{ kind: 'tool', name: 'write_test', args: { text: 'x' }, result: 'done' }]])
      await session.submit(submit('go'))
      await record.waitFor((events) => events.some((e) => e.type === 'interactionRequested'), '没有得到审批请求')
      const requested = record.events.find((e) => e.type === 'interactionRequested')
      expect(requested?.type).toBe('interactionRequested')
      const interaction = (requested as Extract<EngineSessionEvent, { type: 'interactionRequested' }>).interaction
      expect(interaction.kind).toBe('approval')
      await record.waitFor((events) => shape(events).includes('state:awaiting'), '没有进入 awaiting')
      session.respond(interaction.id, { kind: 'approval', decision: 'approve', scope: 'once', feedback: null })
      await record.waitFor((events) => shape(events).includes('state:idle'), '答复后没有结束')
      expect(shape(record.events)).toContain('interactionResolved')
      expect(writeCalls.count).toBe(1)
      record.subscription.dispose()
    })

    test('C-INTERACTION-EXPIRED', async () => {
      const session = await openNew()
      const error = (() => {
        try {
          session.respond('does-not-exist', { kind: 'dismiss' })
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe(EngineErrorCode.interactionExpired)
    })

    test('C-QUEUE', async () => {
      const session = await openNew()
      const record = recorder(session)
      target.script([[{ kind: 'interaction', interaction: { kind: 'confirm', title: '停一下', message: '继续？' } }]])
      await session.submit(submit('first'))
      await record.waitFor((events) => events.some((e) => e.type === 'interactionRequested'), '没有等到交互')
      await session.submit(submit('later', 'followUp'))
      await record.waitFor(
        (events) => events.some((e) => e.type === 'queue' && e.queue.items.some((i) => i.text === 'later')),
        '队列里没有 later',
      )
      const item = session.queue().items.find((i) => i.text === 'later')
      expect(item).toBeDefined()
      session.withdraw(item!.id)
      await record.waitFor(
        (events) =>
          events.filter((e) => e.type === 'queue').length >= 2 &&
          events.filter((e) => e.type === 'queue').at(-1)!.queue.items.length === 0,
        '撤回后队列没有变空',
      )
      await session.cancel()
      record.subscription.dispose()
    })

    /** 换层：一条 followUp 搬到 steer，deliverAs 变了、拿到新 id、其余项顺序不动 */
    test('C-QUEUE-MOVE', async () => {
      const session = await openNew()
      const record = recorder(session)
      target.script([[{ kind: 'interaction', interaction: { kind: 'confirm', title: '停一下', message: '继续？' } }]])
      await session.submit(submit('first'))
      await record.waitFor((events) => events.some((e) => e.type === 'interactionRequested'), '没有等到交互')

      await session.submit(submit('one', 'followUp'))
      await session.submit(submit('two', 'followUp'))
      await record.waitFor(
        (events) => events.some((e) => e.type === 'queue' && e.queue.items.length === 2),
        '两条排队项没进队列',
      )
      const before = session.queue().items
      const moving = before.find((i) => i.text === 'one')!
      expect(moving.deliverAs).toBe('followUp')

      await session.moveQueued(moving.id, 'steer')

      const after = session.queue().items
      expect(after).toHaveLength(2)
      // 该正文的层变了、id 也换了；另一条原地不动
      const moved = after.find((i) => i.text === 'one')!
      expect(moved.deliverAs).toBe('steer')
      expect(moved.id).not.toBe(moving.id)
      expect(after.find((i) => i.text === 'two')).toEqual(before.find((i) => i.text === 'two'))
      await session.cancel()
      record.subscription.dispose()
    })

    /** 撤回一个不存在的 id：kernel.not_found，队列照旧 */
    test('C-QUEUE-WITHDRAW-MISSING', async () => {
      const session = await openNew()
      const record = recorder(session)
      target.script([[{ kind: 'interaction', interaction: { kind: 'confirm', title: '停一下', message: '继续？' } }]])
      await session.submit(submit('first'))
      await record.waitFor((events) => events.some((e) => e.type === 'interactionRequested'), '没有等到交互')
      await session.submit(submit('later', 'followUp'))
      await record.waitFor(
        (events) => events.some((e) => e.type === 'queue' && e.queue.items.length === 1),
        '队列里没有 later',
      )

      const error = (() => {
        try {
          session.withdraw('does-not-exist')
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('kernel.not_found')
      expect(session.queue().items).toHaveLength(1)
      await session.cancel()
      record.subscription.dispose()
    })

    test('C-POSTURE-ISOLATION', async () => {
      const a = await openNew('ask')
      const b = await openNew('full-access')
      const ra = recorder(a)
      const rb = recorder(b)
      const askTurn = [[{ kind: 'tool', name: 'write_test', args: { text: 'a' }, result: 'ok' }]] as const
      const idleCount = (events: readonly EngineSessionEvent[]): number =>
        events.filter((e) => e.type === 'state' && e.state === 'idle').length
      for (let i = 0; i < 2; i++) {
        target.script([...askTurn])
        await a.submit(submit(`a${i}`))
        await ra.waitFor((events) => pendingInteractionId(events, answered) !== null, `A 第 ${i} 轮没有出审批`)
        const pendingId = pendingInteractionId(ra.events, answered)!
        answered.add(pendingId)
        a.respond(pendingId, { kind: 'approval', decision: 'approve', scope: 'once', feedback: null })
        await ra.waitFor((events) => idleCount(events) >= i + 1, `A 第 ${i} 轮没有结束`)

        target.script([...askTurn])
        await b.submit(submit(`b${i}`))
        await rb.waitFor((events) => idleCount(events) >= i + 1, `B 第 ${i} 轮没有结束`)
      }
      const aApprovals = ra.events.filter((e) => e.type === 'interactionRequested').length
      const bApprovals = rb.events.filter((e) => e.type === 'interactionRequested').length
      // A（ask + write 级工具）每轮都要审批；B（full-access）从不出审批
      expect(aApprovals).toBe(2)
      expect(bApprovals).toBe(0)
      ra.subscription.dispose()
      rb.subscription.dispose()
    })

    test('C-TOOLS-FROZEN', async () => {
      const error = (() => {
        try {
          target.engine.registerTool(echoTool({ calls: [] }))
        } catch (e) {
          return e
        }
        return undefined
      })()
      expect((error as AppError).code).toBe(EngineErrorCode.toolsFrozen)
      const session = await openNew()
      expect(session.state()).toBe('idle')
    })

    test('C-CUSTOM-TOOL', async () => {
      const session = await openNew()
      const record = recorder(session)
      target.script([[{ kind: 'tool', name: 'echo_test', args: { text: 'x' }, result: 'ignored' }]])
      await session.submit(submit('go'))
      await record.waitFor((events) => shape(events).includes('state:idle'), '这一轮没有结束')
      expect(echo.calls).toEqual([{ text: 'x' }])
      expect(allText(timelinePage(record.events))).toContain('echo:x')
      record.subscription.dispose()
    })

    test('C-PAGE', async () => {
      const session = await openNew()
      const record = recorder(session)
      for (let i = 0; i < 3; i++) {
        target.script([[{ kind: 'text', text: `reply${i}` }]])
        await session.submit(submit(`m${i}`))
        await record.waitFor(
          (events) => events.filter((e) => e.type === 'state' && e.state === 'idle').length >= i + 1,
          `第 ${i} 轮没有结束`,
        )
      }
      const first = await session.page('main', null)
      expect(turnCount(first)).toBe(3)
      const second = await session.page('main', 't2')
      expect(turnCount(second)).toBe(1)
      record.subscription.dispose()
    })

    /*
     * C-DRAFT-CONTROLS（方案 §04 的 AgentEngine.draftControls）。
     *
     * 三个断言，逐条对应方案的规则：
     *   1. 只读 —— 调它**不开会话**（target.engine.opened 一条都不多）；
     *   2. 默认姿态是 auto-edit；
     *   3. 草稿给的 model / thinking / posture 原样回显（用户在入口页选了什么，
     *      发送时带进 threads.create 的就是什么）。
     *
     * 两个引擎在这里比的是「草稿表怎么组装」：档位候选的**来源**各不一样
     * （omp 烤在模型目录里、FakeEngine 由 opts 注入），所以这里只断言形状与回显。
     */
    test('C-DRAFT-CONTROLS', async () => {
      const openedBefore = target.openedCount?.() ?? null

      const draft = await target.engine.draftControls({})
      /* 只读：一条会话都没有开。 */
      if (openedBefore !== null) expect(target.openedCount?.()).toBe(openedBefore)
      /* 默认姿态是 auto-edit（07 页 §5C 的 threads.create 同一条默认值）。 */
      expect(draft.posture).toBe('auto-edit')
      expect(draft.planMode).toBe(false)
      expect(draft.goal).toBeNull()
      expect(draft.context).toBeNull()
      /*
       * 两档可用性也在草稿表里（04 页 §2.2 的 Controls.available）：入口页据此决定
       * 画不画计划 / 目标选择器。两个引擎都报**布尔**，真实现现读 agent 设置。
       */
      expect(typeof draft.available.plan).toBe('boolean')
      expect(typeof draft.available.goal).toBe('boolean')

      /* 草稿给的三格原样回显。模型取目录里第一条（两个引擎都至少有它）。 */
      const first = draft.model.choices[0]
      const alias = first === undefined ? null : (target.draftAliasOf?.(first.ref) ?? null)
      if (first !== undefined) {
        const echoed = await target.engine.draftControls({ model: first.ref, posture: 'full-access' })
        if (target.draftAliasOf !== undefined) expect(target.draftAliasOf(echoed.model.current)).toBe(alias)
        expect(echoed.posture).toBe('full-access')
      }

      /* 草稿里的档位跟着那张表：给了就在候选里。 */
      const withThinking = await target.engine.draftControls({ thinking: 'low' })
      expect(withThinking.thinking.current).toBe('low')
    })

    test('C-REOPEN', async () => {
      const first = await openNew()
      const record = recorder(first)
      for (let i = 0; i < 2; i++) {
        target.script([[{ kind: 'text', text: `reply${i}` }]])
        await first.submit(submit(`keep${i}`))
        await record.waitFor(
          (events) => events.filter((e) => e.type === 'state' && e.state === 'idle').length >= i + 1,
          `第 ${i} 轮没有结束`,
        )
      }
      const file = first.sessionFile
      const before = await first.page('main', null)
      record.subscription.dispose()
      await first.dispose()
      const reopened = await target.engine.openSession({
        key: 'conformance',
        cwd: target.cwd,
        sessionFile: file,
        posture: 'ask',
        model: null,
        thinking: null,
      })
      const after = await reopened.page('main', null)
      expect(turnCount(after)).toBe(turnCount(before))
      expect(allText(after)).toContain('keep0')
      await reopened.dispose()
    })

    test('C-DISPOSE', async () => {
      const session = await openNew()
      const record = recorder(session)
      target.script([[{ kind: 'text', text: 'later' }]])
      await session.dispose()
      const seen = record.events.length
      await Bun.sleep(100)
      expect(record.events.length).toBe(seen)
      record.subscription.dispose()
    })
  })
}

function submit(text: string, deliverAs: 'turn' | 'steer' | 'followUp' = 'turn') {
  return { text, images: [], files: [], skills: [], deliverAs } as const
}

function echoTool(record: { calls: unknown[] }): EngineToolSpec<z.ZodObject<{ text: z.ZodString }>> {
  return {
    name: 'echo_test',
    label: '回显测试',
    description: 'Echo the given text back.',
    parameters: z.object({ text: z.string() }),
    approval: 'read',
    async execute(params) {
      record.calls.push({ text: params.text })
      return { text: `echo:${params.text}` }
    },
  }
}

function writeTool(record: { count: number }): EngineToolSpec<z.ZodObject<{ text: z.ZodString }>> {
  return {
    name: 'write_test',
    label: '写入测试',
    description: 'Pretend to write a file.',
    parameters: z.object({ text: z.string() }),
    approval: 'write',
    async execute(params) {
      record.count++
      return { text: `wrote:${params.text}` }
    },
  }
}

export type { Interaction }
