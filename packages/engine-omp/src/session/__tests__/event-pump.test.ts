import { describe, expect, test } from 'bun:test'
import '@oh-my-pi/pi-coding-agent/config/all-settings'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { EngineSession, EngineSessionEvent, EngineToolSpec, OpenSessionSpec, SubmitInput } from '@poietica/engine'
import type { Logger, LogLevel } from '@poietica/foundation'
import type { TranscriptOperation } from '@poietica/transcript'
import { z } from 'zod'
import { TOOL_FALLBACK_TEXT } from '../../projector/live'
import { hashMediaRef } from '../../projector/media'
import { wrapOmpSession } from '../omp-session-adapter'

/*
 * 事件泵的十一条判据（R-02）：一次投影异常只影响它自己负责的那一行，事件泵照常处理后面的
 * 事件，收尾一定发生。被测对象是**真的适配器 + 真的 OmpSession + 真的 EventFaults**，只把
 * omp 的 AgentSession 换成假会话（搭法同 queue.test.ts）。每条用例都额外断言没有发出任何
 * timelineReset（R-02 的 E0）—— 开着轮时整页重取会与增量投影的编号打架，这条修复明确不这么做。
 */

interface LogRecord {
  readonly level: LogLevel
  readonly msg: string
  readonly data: Readonly<Record<string, unknown>>
}

/** 记录型 logger：捕获 warn 用的就是它（noopLogger 看不见任何东西） */
function recordingLogger(): { readonly records: LogRecord[] } & Logger {
  const records: LogRecord[] = []
  const make = (bindings: Record<string, unknown>): { readonly records: LogRecord[] } & Logger => ({
    records,
    debug: (msg, data) => records.push({ level: 'debug', msg, data: { ...bindings, ...(data ?? {}) } }),
    info: (msg, data) => records.push({ level: 'info', msg, data: { ...bindings, ...(data ?? {}) } }),
    warn: (msg, data) => records.push({ level: 'warn', msg, data: { ...bindings, ...(data ?? {}) } }),
    error: (msg, data) => records.push({ level: 'error', msg, data: { ...bindings, ...(data ?? {}) } }),
    child: (more) => make({ ...bindings, ...more }),
  })
  return make({})
}

type AssistantMessage = { readonly stopReason?: string; readonly errorMessage?: string }
type ContextUsage = { readonly tokens?: number; readonly contextWindow?: number } | undefined

/** omp 的 UI 面：审批闸门经它的 select 进来（认 `Allow tool:` 与那两颗按钮） */
interface UiLike {
  select(title: string, options: string[]): Promise<string | undefined>
}

interface Fixture {
  readonly session: EngineSession
  readonly events: EngineSessionEvent[]
  readonly logs: LogRecord[]
  readonly ui: UiLike
  feed(event: Record<string, unknown>): void
  /** 让 `getLastAssistantMessage()` 抛异常（读不到结局那条路） */
  failLastAssistant(): void
  lastAssistant(message: AssistantMessage | undefined): void
  /** 让 `getContextUsage()` 抛异常（旁路读数的失败源） */
  failContextUsage(): void
  /** omp 把一条排队的插话折进上下文：从队列拿走，再报一次 queue_update */
  takeSteer(text: string): void
}

const BASE_SPEC: OpenSessionSpec = {
  key: 'event-pump',
  cwd: 'C:\\work',
  sessionFile: null,
  posture: 'ask',
  model: null,
  thinking: null,
}

async function fixture(tools: ReadonlyMap<string, EngineToolSpec> = new Map()): Promise<Fixture> {
  const listeners: ((event: Record<string, unknown>) => void)[] = []
  const steering: string[] = []
  const followUp: string[] = []
  const logger = recordingLogger()
  let ui: UiLike | null = null
  let lastAssistantOf: () => AssistantMessage | undefined = () => undefined
  let contextUsageOf: () => ContextUsage = () => undefined

  const emitQueue = (): void => {
    for (const listener of listeners) {
      listener({ type: 'queue_update', steering: [...steering], followUp: [...followUp] })
    }
  }

  const agentSession = {
    sessionId: 'session-pump',
    sessionFile: 'session-pump.jsonl',
    settings: Settings.isolated(),
    model: undefined,
    messages: [],
    skills: [],
    systemPrompt: [],
    /* 上下文构成要读到的两格：tokenizer 与（空）工具/技能表 */
    agent: { tokenizer: { countTokens: () => 0, countMessages: () => 0 } },
    sessionManager: {
      getArtifactsDir: () => 'C:\\work\\artifacts',
      getSessionId: () => 'session-pump',
      getCwd: () => 'C:\\work',
      /* 目标宿主（RpcGoalController）接回目标时要读的格（审查 R-11） */
      buildSessionContext: () => ({ mode: 'none', modeData: undefined }),
    },
    subscribe(listener: (event: Record<string, unknown>) => void): () => void {
      listeners.push(listener)
      return () => undefined
    },
    prompt: async (): Promise<boolean> => true,
    promptCustomMessage: async (): Promise<boolean> => true,
    steer: async (text: string): Promise<void> => {
      steering.push(text)
      emitQueue()
    },
    followUp: async (text: string): Promise<void> => {
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
    getContextUsage: (): ContextUsage => contextUsageOf(),
    getLastAssistantMessage: (): AssistantMessage | undefined => lastAssistantOf(),
    getAvailableThinkingLevels: () => [],
    /*
     * 目标宿主（RpcGoalController）要读的那几格（审查 R-11）：事件泵里的会话事件都会先过
     * 控制器，缺一格它就整条 observe 抛错、E8 的「不产生 warn」当场破功。
     */
    getGoalModeState: () => undefined,
    setGoalModeState: (): void => undefined,
    getPlanModeState: () => undefined,
    getTodoPhases: () => [],
    waitForIdle: async (): Promise<void> => undefined,
    isDisposed: false,
    isSessionTransitioning: false,
    hasAdmittedSubmission: false,
    queuedMessageCount: 0,
    goalRuntime: { clearAccounting: (): void => undefined },
  }

  const session = await wrapOmpSession({
    mediaRef: hashMediaRef,
    spec: BASE_SPEC,
    settings: agentSession.settings,
    agentSession,
    setToolUIContext: (next) => {
      ui = next as UiLike
    },
    mcpManager: null,
    tools,
    logger,
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
    logs: logger.records,
    get ui(): UiLike {
      if (ui === null) throw new Error('ui context 还没接上')
      return ui
    },
    feed: (event) => {
      for (const listener of listeners) listener(event)
    },
    failLastAssistant: () => {
      lastAssistantOf = () => {
        throw new Error('last assistant unavailable')
      }
    },
    lastAssistant: (message) => {
      lastAssistantOf = () => message
    },
    failContextUsage: () => {
      contextUsageOf = () => {
        throw new Error('context usage unavailable')
      }
    },
    takeSteer: (text) => {
      const at = steering.indexOf(text)
      if (at >= 0) steering.splice(at, 1)
      emitQueue()
    },
  }
}

function submit(text: string, deliverAs: 'turn' | 'steer' | 'followUp' = 'turn'): SubmitInput {
  return { text, images: [], files: [], skills: [], deliverAs }
}

type FrameUpsert = Extract<TranscriptOperation, { readonly op: 'frame.upsert' }>
type TurnUpsert = Extract<TranscriptOperation, { readonly op: 'turn.upsert' }>
type Append = Extract<TranscriptOperation, { readonly op: 'append' }>

function opsOf(events: readonly EngineSessionEvent[]): readonly TranscriptOperation[] {
  return events.flatMap((event) => (event.type === 'timeline' ? event.ops : []))
}

function framesOf(ops: readonly TranscriptOperation[]): readonly FrameUpsert[] {
  return ops.filter((op): op is FrameUpsert => op.op === 'frame.upsert')
}

function turnsOf(ops: readonly TranscriptOperation[]): readonly TurnUpsert[] {
  return ops.filter((op): op is TurnUpsert => op.op === 'turn.upsert')
}

/** 一条 turn.upsert 是「开轮」还是「收轮」：同一轮会出现两次，数轮号要先去重 */
function closedTurnsOf(ops: readonly TranscriptOperation[]): readonly TurnUpsert[] {
  return turnsOf(ops).filter((turn) => turn.turn.state !== 'running')
}

function appendsOf(ops: readonly TranscriptOperation[]): readonly Append[] {
  return ops.filter((op): op is Append => op.op === 'append')
}

function warningsOf(logs: readonly LogRecord[], eventType: string): readonly LogRecord[] {
  return logs.filter((entry) => entry.msg === 'omp event projection failed' && entry.data.eventType === eventType)
}

/** 降级帧正文的形状（omp 工具结果那一套：{ content: [text 块] }） */
function fallbackTextOf(frame: FrameUpsert | undefined): string {
  if (frame === undefined || frame.frame.kind !== 'tool') return ''
  const output = frame.frame.output as { content?: readonly { type?: unknown; text?: unknown }[] } | undefined
  const block = output?.content?.[0]
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
}

/** E0：这条修复明确不在开着轮时整页重取（R-02 §2.2） */
function expectNoReset(events: readonly EngineSessionEvent[]): void {
  expect(events.some((event) => event.type === 'timelineReset')).toBe(false)
}

describe('omp 事件泵（R-02 §4）', () => {
  test('E1 读不到结局：agent_end 仍把这一轮收成 completed + idle', async () => {
    const f = await fixture()
    f.failLastAssistant()
    await f.session.submit(submit('第一句'))
    expect(f.session.state()).toBe('running')

    f.feed({ type: 'agent_end' })

    expect(f.session.state()).toBe('idle')
    expect(f.events.some((event) => event.type === 'state' && event.state === 'idle')).toBe(true)
    const turn = turnsOf(opsOf(f.events)).at(-1)
    expect(turn?.turn.state).toBe('completed')
    expect(f.logs.some((entry) => entry.msg === 'turn outcome unavailable')).toBe(true)
    expectNoReset(f.events)
  })

  test('E2 收尾失败之后，上下文读数照样上报', async () => {
    const f = await fixture()
    f.failLastAssistant()
    await f.session.submit(submit('第一句'))

    f.feed({ type: 'agent_end' })

    expect(f.events.some((event) => event.type === 'contextUsage')).toBe(true)
    expectNoReset(f.events)
  })

  test('E3 收尾失败之后下一轮接着开，插话落在新轮里', async () => {
    const f = await fixture()
    f.failLastAssistant()
    await f.session.submit(submit('第一句'))
    f.feed({ type: 'agent_end' })

    await f.session.submit(submit('第二句'))
    await f.session.submit(submit('插一句', 'steer'))
    f.takeSteer('插一句')
    f.feed({ type: 'message_start', message: { role: 'user', content: '插一句' } })

    const ops = opsOf(f.events)
    const ordinals = turnsOf(ops).map((turn) => turn.turn.ordinal)
    expect([...new Set(ordinals)]).toEqual([1, 2])
    const steered = framesOf(ops).filter((frame) => frame.frame.kind === 'text' && frame.frame.text === '插一句')
    expect(steered).toHaveLength(1)
    const openTurns = turnsOf(ops).filter((turn) => turn.turn.state === 'running')
    expect(steered[0]?.turnId).toBe(openTurns.at(-1)?.turn.turnId)
    expectNoReset(f.events)
  })

  test('E4 旁路失败只记日志：message_end 之后的增量 offset 连续', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    f.failContextUsage()

    f.feed({ type: 'message_end', message: { role: 'assistant' } })
    f.feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'abc' } })
    f.feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'def' } })

    const warns = warningsOf(f.logs, 'message_end')
    expect(warns).toHaveLength(1)
    expect(appendsOf(opsOf(f.events)).map((op) => op.offset)).toEqual([0, 3])
    expectNoReset(f.events)
  })

  test('E5 工具 end 投影失败：这一格就地降级成 error，后面的事件照常', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    f.feed({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } })
    f.feed({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      isError: true,
      result: {
        get content(): readonly unknown[] {
          throw new Error('boom')
        },
      },
    })
    f.feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '继续' } })

    const tool = framesOf(opsOf(f.events))
      .filter((frame) => frame.frame.kind === 'tool')
      .at(-1)
    expect(tool?.frame.kind === 'tool' && tool.frame.frameId).toBe('tool.c1')
    expect(tool?.frame.kind === 'tool' && tool.frame.state).toBe('error')
    expect(tool?.frame.kind === 'tool' && tool.frame.error).toBe(TOOL_FALLBACK_TEXT)
    expect(fallbackTextOf(tool)).toBe(TOOL_FALLBACK_TEXT)
    expect(appendsOf(opsOf(f.events)).some((op) => op.text === '继续')).toBe(true)
    expect(warningsOf(f.logs, 'tool_execution_end')).toHaveLength(1)
    expectNoReset(f.events)
  })

  test('E5b start 失败之后的 end 正常：先把这一格补出来，再覆盖回真实结果', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    const explosive: unknown = {
      toString: () => {
        throw new Error('boom')
      },
      valueOf: () => ({}),
    }
    f.feed({ type: 'tool_execution_start', toolCallId: 'c1', toolName: explosive, args: { path: 'a.ts' } })

    const fallback = framesOf(opsOf(f.events))
      .filter((frame) => frame.frame.kind === 'tool')
      .at(-1)
    expect(fallback?.frame.kind === 'tool' && fallback.frame.state).toBe('running')
    expect(fallbackTextOf(fallback)).toBe(TOOL_FALLBACK_TEXT)

    f.feed({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', result: '真实结果' })

    const done = framesOf(opsOf(f.events))
      .filter((frame) => frame.frame.kind === 'tool')
      .at(-1)
    expect(done?.frame.kind === 'tool' && done.frame.state).toBe('done')
    expect(done?.frame.kind === 'tool' && done.frame.output).toBe('真实结果')
    expectNoReset(f.events)
  })

  test('E6 toolCallId 认不出：只记日志，不降级也不挡后面的帧', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    const exotic: unknown = Object.create(null)

    f.feed({ type: 'tool_execution_end', toolCallId: exotic, toolName: 'bash', result: 'x' })
    f.feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '后面' } })

    expect(warningsOf(f.logs, 'tool_execution_end')).toHaveLength(1)
    expect(framesOf(opsOf(f.events)).filter((frame) => frame.frame.kind === 'tool')).toHaveLength(0)
    expect(appendsOf(opsOf(f.events)).some((op) => op.text === '后面')).toBe(true)
    expectNoReset(f.events)
  })

  test('E7 同一轮同一事件类型只 warn 一次，轮终汇总，下一轮重新开始', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    f.failContextUsage()
    f.feed({ type: 'message_end' })
    f.feed({ type: 'message_end' })
    expect(warningsOf(f.logs, 'message_end')).toHaveLength(1)

    f.feed({ type: 'agent_end' })
    const summary = f.logs.filter((entry) => entry.msg === 'omp event projection failures suppressed')
    expect(summary).toHaveLength(1)
    expect(summary[0]?.data.count).toBe(1)

    await f.session.submit(submit('第二句'))
    f.feed({ type: 'message_end' })
    expect(warningsOf(f.logs, 'message_end')).toHaveLength(2)
    expectNoReset(f.events)
  })

  test('E8 正常路径：不产生 warn，也不产生降级帧', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    f.feed({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } })
    f.feed({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', result: '内容' })
    f.feed({ type: 'message_end', message: { role: 'assistant' } })
    f.feed({ type: 'agent_end' })

    expect(f.logs.filter((entry) => entry.level === 'warn')).toEqual([])
    expect(fallbackTextOf(framesOf(opsOf(f.events)).at(-1))).toBe('')
    expect(f.session.state()).toBe('idle')
    expectNoReset(f.events)
  })

  test('E9 待答交互跨过 agent_end：答完之后收成 idle，中间不回到 running', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    const asked = f.ui.select('Allow tool: bash\nCommand: ls', ['Approve', 'Deny'])
    expect(f.session.state()).toBe('awaiting')

    f.feed({ type: 'agent_end' })
    expect(f.session.state()).toBe('awaiting')

    const pending = f.session.interactions()
    expect(pending).toHaveLength(1)
    const resolvedAt = f.events.length
    f.session.respond(pending[0]!.id, { kind: 'approval', decision: 'approve', scope: 'once', feedback: null })

    expect(f.session.state()).toBe('idle')
    expect(f.events.slice(resolvedAt).some((event) => event.type === 'state' && event.state === 'running')).toBe(false)
    await asked
    expectNoReset(f.events)
  })

  /*
   * omp 的 agent_end 带 isTerminal / awaitingAsyncWork（18.12.6 在这里修了「Esc 停止后后台作业结束
   * 让 agent 自己重启」）。非终态的 settle 是**排程暂停**，不是这一轮结束：retry / compaction continuation /
   * stop-time reminders / queued input 之后还有东西要跑。此时收轮会让下一段输出落进一个关掉的轮。
   *
   * awaitingAsyncWork 那一档也一样：omp 只把标题置 idle，run 还等后台作业的结果；看门狗会等作业真的排干净再收轮。
   */
  test('E11 非终态 agent_end 不收轮：仍 running、开着的轮不封口；随后终态才 idle', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    f.feed({ type: 'agent_end', isTerminal: false })

    expect(f.session.state()).toBe('running')
    expect(closedTurnsOf(opsOf(f.events))).toHaveLength(0)
    expect(turnsOf(opsOf(f.events)).filter((turn) => turn.turn.state === 'running')).toHaveLength(1)
    /* 读数与异常账仍要跟上：不收轮不等于把这一段的账漏掉 */
    expect(f.events.some((event) => event.type === 'contextUsage')).toBe(true)

    f.feed({ type: 'agent_end' })

    expect(f.session.state()).toBe('idle')
    expect(closedTurnsOf(opsOf(f.events))).toHaveLength(1)
    expectNoReset(f.events)
  })

  test('E12 非终态但 awaitingAsyncWork：仍属同一个 run，等后台活排干净才收轮', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    f.feed({ type: 'agent_end', isTerminal: false, awaitingAsyncWork: true })

    /* omp 的 event-controller 对 awaitingAsyncWork 也只把标题置 idle，run 本身没结束 —— 不能在这里提前收轮 */
    expect(f.session.state()).toBe('running')
    expect(closedTurnsOf(opsOf(f.events))).toHaveLength(0)

    /* 夹具没有后台活：看门狗下一拍就发现会话已静，按终态收 */
    await Bun.sleep(0)
    expect(f.session.state()).toBe('idle')
    expect(closedTurnsOf(opsOf(f.events))).toHaveLength(1)
    expectNoReset(f.events)
  })

  /*
   * 终态 agent_end 不保证会来：abort 会把排好的重试 / 压缩续跑取消在 agent_start 之前，后台作业也可能被
   * 取消到不投递唤醒。omp 自己的 TUI 因此给非终态 settle 挂一条看门狗（`#finishWhenRunSettles`）；这里照抄
   * 同一套判据 —— 会话真的静下来就收轮，否则界面永远停在 running。
   */
  test('E13 非终态之后终态一直不来：等会话静下来由看门狗收轮', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    f.feed({ type: 'agent_end', isTerminal: false })
    expect(f.session.state()).toBe('running')

    /* 夹具的 waitForIdle 立刻返回、没有后台活 / 队列 / admitted 提交 → 看门狗应当收轮 */
    await Bun.sleep(0)

    expect(f.session.state()).toBe('idle')
    expect(closedTurnsOf(opsOf(f.events))).toHaveLength(1)
    expectNoReset(f.events)
  })

  test('E14 非终态之后新一轮开跑：晚到的看门狗不能把新一轮收掉', async () => {
    const f = await fixture()
    await f.session.submit(submit('第一句'))
    f.feed({ type: 'agent_end', isTerminal: false })
    /* 排程续跑 / 排队输入真的开跑：换代。之后看门狗醒来必须发现换代并放手 */
    f.feed({ type: 'agent_start' })
    await Bun.sleep(0)

    expect(f.session.state()).toBe('running')
    expect(closedTurnsOf(opsOf(f.events))).toHaveLength(0)
    expectNoReset(f.events)
  })

  test('E10 重复的 agent_end：state idle 与轮终帧都只发一次', async () => {
    const f = await fixture()
    f.lastAssistant({ stopReason: 'error', errorMessage: '模型出错' })
    await f.session.submit(submit('第一句'))

    f.feed({ type: 'agent_end' })
    f.feed({ type: 'agent_end' })

    expect(f.events.filter((event) => event.type === 'state' && event.state === 'idle')).toHaveLength(1)
    expect(closedTurnsOf(opsOf(f.events))).toHaveLength(1)
    expect(f.session.state()).toBe('idle')
    expectNoReset(f.events)
  })
})

/** 只给事件泵看 streamInput 那一格的工具规格（execute 不会被调用） */
function toolSpec(name: string, streamInput: boolean): EngineToolSpec {
  return {
    name,
    label: name,
    description: name,
    parameters: z.object({}),
    approval: 'read',
    streamInput,
    execute: async () => ({ content: [] }),
  } as unknown as EngineToolSpec
}

describe('工具参数流式上屏（toolcall_start / delta / end）', () => {
  const streamed = (): ReadonlyMap<string, EngineToolSpec> =>
    new Map([
      ['intelligent_ui', toolSpec('intelligent_ui', true)],
      ['bash', toolSpec('bash', false)],
    ])

  const toolcall = (type: string, block: Record<string, unknown>): Record<string, unknown> =>
    type === 'toolcall_end'
      ? { type: 'message_update', assistantMessageEvent: { type, contentIndex: 0, toolCall: block } }
      : { type: 'message_update', assistantMessageEvent: { type, contentIndex: 0, partial: { content: [block] } } }

  test('P1 声明 streamInput 的工具：start 即占格（inputPending），end 带齐入参、仍等工具开跑', async () => {
    const f = await fixture(streamed())
    await f.session.submit(submit('画个界面'))
    f.feed(toolcall('toolcall_start', { type: 'toolCall', id: 'u1', name: 'intelligent_ui', arguments: {} }))
    f.feed(
      toolcall('toolcall_end', {
        type: 'toolCall',
        id: 'u1',
        name: 'intelligent_ui',
        arguments: { title: '表', html: '<p>x</p>' },
      }),
    )
    const frames = framesOf(opsOf(f.events)).filter((op) => op.frame.kind === 'tool')
    expect(frames).toHaveLength(2)
    const [first, last] = frames
    expect(first?.frame).toMatchObject({ toolCallId: 'u1', name: 'intelligent_ui', inputPending: true })
    expect(last?.frame).toMatchObject({
      toolCallId: 'u1',
      inputPending: true,
      input: { title: '表', html: '<p>x</p>' },
    })
    expect(last?.frame.frameId).toBe(first?.frame.frameId ?? '')
    expectNoReset(f.events)
  })

  test('P2 普通工具与缺 id 的块：不产生任何工具帧', async () => {
    const f = await fixture(streamed())
    await f.session.submit(submit('跑一下'))
    f.feed(toolcall('toolcall_start', { type: 'toolCall', id: 'b1', name: 'bash', arguments: {} }))
    f.feed(toolcall('toolcall_delta', { type: 'toolCall', id: '', name: 'intelligent_ui', arguments: {} }))
    f.feed({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 3, partial: {} } })
    expect(framesOf(opsOf(f.events)).filter((op) => op.frame.kind === 'tool')).toHaveLength(0)
    expect(f.logs.filter((entry) => entry.level === 'warn')).toHaveLength(0)
    expectNoReset(f.events)
  })

  test('P3 工具开跑后同一格接着用：tool_execution_start 不另起一帧，迟到的增量不理', async () => {
    const f = await fixture(streamed())
    await f.session.submit(submit('画个界面'))
    f.feed(toolcall('toolcall_start', { type: 'toolCall', id: 'u2', name: 'intelligent_ui', arguments: {} }))
    f.feed({
      type: 'tool_execution_start',
      toolCallId: 'u2',
      toolName: 'intelligent_ui',
      args: { title: 't', html: 'h' },
    })
    f.feed(
      toolcall('toolcall_end', { type: 'toolCall', id: 'u2', name: 'intelligent_ui', arguments: { title: 'late' } }),
    )
    const frames = framesOf(opsOf(f.events)).filter((op) => op.frame.kind === 'tool')
    expect(new Set(frames.map((op) => op.frame.frameId)).size).toBe(1)
    expect(frames.at(-1)?.frame).toMatchObject({ input: { title: 't', html: 'h' } })
    expect(frames.at(-1)?.frame).not.toHaveProperty('inputPending')
    expectNoReset(f.events)
  })
})
