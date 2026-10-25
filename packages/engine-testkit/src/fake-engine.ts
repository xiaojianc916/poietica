import {
  type AgentEngine,
  type Capabilities,
  type ContextUsage,
  type Controls,
  type CustomProviderDef,
  EngineErrorCode,
  type EngineInfo,
  type EngineSession,
  type EngineSessionEvent,
  type EngineToolSpec,
  type Interaction,
  type InteractionAnswer,
  interactionCardOf,
  type MarketplaceEntry,
  type McpCatalogEntry,
  type McpServerInfo,
  type McpStatus,
  type ModelInfo,
  type ModelRef,
  type OpenSessionSpec,
  type PluginInfo,
  type Posture,
  type ProviderInfo,
  type QueueSnapshot,
  type SessionState,
  type SettingDescriptor,
  type SideTopic,
  type SideTurn,
  type SkillInfo,
  type SlashCommand,
  type SubmitInput,
  type TurnContextBlock,
  type UsageSample,
} from '@poietica/engine'
import {
  AppError,
  type Clock,
  createId,
  Emitter,
  SystemErrorCode,
  systemClock,
  toDisposable,
} from '@poietica/foundation'
import {
  applyOps,
  emptyTimeline,
  frameId,
  pageFromState,
  stepId,
  type TranscriptOperation,
  type TranscriptPage,
  turnId,
} from '@poietica/transcript'
import type { z } from 'zod'
import { defaultScript, type ScenarioScript, type ScenarioStep } from './scenario'

// 这些 schema 与推导类型同名（值来自 @poietica/engine），在本文件里一律走推导类型
type CapabilitiesValue = z.infer<typeof Capabilities>
type ProviderInfoValue = z.infer<typeof ProviderInfo>
type ModelInfoValue = z.infer<typeof ModelInfo>
type SettingDescriptorValue = z.infer<typeof SettingDescriptor>
type SkillInfoValue = z.infer<typeof SkillInfo>
type McpServerInfoValue = z.infer<typeof McpServerInfo>
type McpStatusValue = z.infer<typeof McpStatus>
type McpCatalogEntryValue = z.infer<typeof McpCatalogEntry>
type PluginInfoValue = z.infer<typeof PluginInfo>
type MarketplaceEntryValue = z.infer<typeof MarketplaceEntry>

export interface FakeEngineOptions {
  readonly script?: ScenarioScript
  readonly clock?: Clock
  /**
   * 草稿控件表要报的思考档位。omp 的档位梯子是**按模型**烤在目录里的（Model.thinking.efforts），
   * FakeEngine 的模型表没有那一格，所以档位改从这里注入。
   */
  readonly thinkingLevels?: readonly string[]
  readonly posture?: Posture
  /**
   * 上下文用量那一格的报数（替身没有真会话，omp 的 getContextUsage 无处可读，只能注入）。
   * 默认 undefined = 一次都不报，与真引擎「还没水合」同义。
   */
  readonly contextUsage?: ContextUsage | null
  readonly autoTitle?: (text: string) => string | null | undefined
  /**
   * MCP 在线目录的替身内容（`mcp.catalog` 返回这些）。真实现要起网络，所以默认空表；
   * 一致性用例与 UI 测试都从这里注入。
   */
  readonly mcpCatalog?: readonly z.infer<typeof McpCatalogEntry>[]
}

export interface FakeToolCall {
  readonly sessionKey: string
  readonly name: string
  readonly params: unknown
  readonly result: string
}

/** 交给替身的每一句（含排队项）：断言「附带的上下文到了引擎」用；替身不把 context 画进时间线 */
export interface FakePrompt {
  readonly sessionKey: string
  readonly text: string
  readonly deliverAs: SubmitInput['deliverAs']
  readonly context: readonly TurnContextBlock[]
}

export interface FakeEngine extends AgentEngine {
  readonly opened: readonly OpenSessionSpec[]
  readonly toolCalls: readonly FakeToolCall[]
  readonly prompts: readonly FakePrompt[]
  readonly pythonInterpreterCalls: readonly (string | null)[]
  /** 会话文件 → omp 记的会话名（用户定名才记）：断言「名字落进了引擎」用 */
  readonly sessionNames: ReadonlyMap<string, string>
  /** 草稿表里 current 的写法（provider/id）；一致性套件比两个引擎的草稿表时用它。 */
  readonly draftAliasOf: (model: ModelRef | null) => string | null
}

const APPROVAL_TIER: Record<EngineToolSpec['approval'], number> = { read: 0, write: 1, exec: 2 }
const POSTURE_MAX: Record<Posture, number> = { ask: 0, 'auto-edit': 1, 'full-access': 2 }

/** 与 omp 的 APPROVAL_MODE_MAX_TIER 一致的放行规则。 */
function needsApproval(posture: Posture, approval: EngineToolSpec['approval']): boolean {
  return APPROVAL_TIER[approval] > POSTURE_MAX[posture]
}

/** 会话文件的账本：dispose 后重开同一个文件要能读回同样的内容（C-REOPEN） */
type SessionLedger = Map<string, TranscriptOperation[]>

/** 侧边话题的账本（omp 存在会话的 artifacts 目录里）：按会话文件分账，重开、分叉、删除都跟着会话文件走 */
type SideLedger = Map<string, SideTopic[]>

/** 侧边一问不占主时间线的轮号：脚本拿到的 turnIndex 恒为它 */
export const SIDE_TURN_INDEX = -1

/** 正在答的那一问：话题号、它在话题里的下标；`cancelled` 由 cancelSide 打上，答题的那一拍看见就收手 */
interface SideRun {
  readonly topicId: string
  readonly turn: number
  cancelled: boolean
}

/** 话题表的次序（与 omp `RpcBtwController.history` 同一条）：新开的在前，同一刻开的按号排。活会话与冷读共用 */
function newestFirst(topics: readonly SideTopic[]): SideTopic[] {
  return [...topics].sort(
    (a, b) => (b.turns[0]?.createdAt ?? 0) - (a.turns[0]?.createdAt ?? 0) || a.id.localeCompare(b.id),
  )
}

/**
 * 一份 ops 账 → 一页时间线。活会话的 page() 与端口的冷读 readPage() 都从这里出：替身里两条路天然同一页。
 * 替身不派子代理：认不出的通道号按端口约定交空页，不抛。
 */
function pageOfOps(ops: readonly TranscriptOperation[], agentId: string, beforeTurnId: string | null): TranscriptPage {
  if (agentId !== 'main') return pageFromState(emptyTimeline())
  const page = pageFromState(applyOps(emptyTimeline(), ops))
  if (beforeTurnId === null) return page
  const limit = Number(beforeTurnId.slice(1))
  return { ...page, items: page.items.filter((item) => item.kind !== 'turn' || item.ordinal < limit) }
}

class FakeSession implements EngineSession {
  readonly sessionId = `fake-${createId()}`
  readonly sessionFile: string
  private readonly listeners = new Set<(event: EngineSessionEvent) => void>()
  private readonly pending = new Map<string, (answer: InteractionAnswer) => void>()
  private readonly outstanding: Interaction[] = []
  private readonly granted = new Set<string>()
  /* `ref` 是调用方给的号：撤回时经 `queueSettled` 原样交回（与真引擎同一条契约，审查 R-20-1） */
  private readonly ledger: {
    id: string
    text: string
    deliverAs: 'steer' | 'followUp'
    createdAt: number
    ref: string | undefined
  }[] = []
  private readonly modes: QueueSnapshot['modes'] = { steer: 'all', followUp: 'all' }
  private ops: TranscriptOperation[]
  private current: SessionState = 'idle'
  private posture: Posture
  private model: ModelRef | null
  private thinking: string | null
  private planMode = false
  /** 目标：正文 + 进行中 / 已暂停（R-10）；没有目标是 null */
  private goal: { objective: string; status: 'active' | 'paused' } | null = null
  private titleRequested = false
  private step = 0
  private turnCount = 0
  private disposed = false
  /** 正在答（或刚开问）的侧边一问；同一时刻只有一问（与 omp 的 RpcBtwController 同一条规矩） */
  private side: SideRun | null = null

  constructor(
    private readonly o: {
      readonly spec: OpenSessionSpec
      readonly script: ScenarioScript
      readonly tools: ReadonlyMap<string, EngineToolSpec>
      readonly toolCalls: FakeToolCall[]
      readonly prompts: FakePrompt[]
      readonly clock: Clock
      readonly store: SessionLedger
      readonly sides: SideLedger
      readonly names: Map<string, string>
      readonly posture: Posture
      readonly contextUsage: () => ContextUsage | null
      /** 自动总结标题的替身：回 null / undefined = 生成失败（不发事件） */
      readonly autoTitle?: (text: string) => string | null | undefined
    },
  ) {
    this.sessionFile = o.spec.sessionFile ?? `fake-${createId()}.jsonl`
    this.ops = [...(o.store.get(this.sessionFile) ?? [])]
    this.posture = o.spec.posture
    this.model = o.spec.model
    this.thinking = o.spec.thinking
    this.turnCount = this.ops.filter((op) => op.op === 'turn.upsert').length
    /* 与 omp 重开历史同一条规矩：上一个进程还在答的那一问记成 interrupted（BtwHistoryStore 的 recover） */
    const topics = o.sides.get(this.sessionFile)
    if (topics !== undefined) {
      o.sides.set(
        this.sessionFile,
        topics.map((topic) =>
          topic.turns.some((turn) => turn.status === 'running')
            ? {
                ...topic,
                turns: topic.turns.map((turn) =>
                  turn.status === 'running' ? { ...turn, status: 'interrupted' as const } : turn,
                ),
              }
            : topic,
        ),
      )
    }
  }

  state(): SessionState {
    return this.current
  }

  /* 侧边一问在答也算忙：会话池回收会把它当场停掉（端口注释） */
  isBusy(): boolean {
    return this.current !== 'idle' || this.side !== null
  }

  subscribe(listener: (event: EngineSessionEvent) => void): { dispose(): void } {
    this.listeners.add(listener)
    return toDisposable(() => this.listeners.delete(listener))
  }

  private emit(event: EngineSessionEvent): void {
    if (this.disposed) return
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // 监听器不抛异常
      }
    }
  }

  /**
   * omp 自动总结出的标题（omp 知识 #17）：替身按端口语义发一条同样的 `sessionTitle` ——
   * 只在本会话**第一条真轮**触发一次，`spec.autoTitle === false` 不触发，生成失败就什么都不发。
   */
  private maybeAutoTitle(input: SubmitInput): void {
    if (this.titleRequested || this.o.spec.autoTitle === false) return
    this.titleRequested = true
    const title = this.o.autoTitle?.(input.text)
    if (title !== undefined && title !== null) {
      this.emit({ type: 'sessionTitle', title, source: 'auto', sessionFile: this.sessionFile })
    }
  }

  /** 与真引擎同一条端口语义：用户定名写进引擎，经 sessionTitle（source: user）报回；空名报 invalid_params */
  async rename(title: string): Promise<void> {
    const name = title.trim()
    if (name === '') throw new AppError(SystemErrorCode.invalidParams, '会话名不能为空')
    this.o.names.set(this.sessionFile, name)
    this.emit({ type: 'sessionTitle', title: name, source: 'user', sessionFile: this.sessionFile })
  }

  private setState(next: SessionState, error: { code: string; message: string } | null = null): void {
    if (this.current === next && error === null) return
    this.current = next
    this.emit({ type: 'state', state: next, error })
  }

  private push(operations: readonly TranscriptOperation[]): void {
    if (operations.length === 0) return
    this.ops.push(...operations)
    this.o.store.set(this.sessionFile, this.ops)
    this.emit({ type: 'timeline', agentId: 'main', ops: operations })
  }

  private assertLive(): void {
    if (this.disposed) throw new AppError(SystemErrorCode.cancelled, '会话已关闭')
  }

  async submit(input: SubmitInput): Promise<void> {
    this.assertLive()
    this.o.prompts.push({
      sessionKey: this.o.spec.key,
      text: input.text,
      deliverAs: input.deliverAs,
      context: [...(input.context ?? [])],
    })
    if (this.current !== 'idle') {
      if (input.deliverAs === 'turn') throw new AppError(EngineErrorCode.busy, 'agent 正忙')
      this.ledger.push({
        id: createId(),
        text: input.text,
        deliverAs: input.deliverAs,
        createdAt: this.o.clock.now(),
        ref: input.ref,
      })
      this.emit({ type: 'queue', queue: this.queue() })
      return
    }
    if (input.deliverAs !== 'turn') {
      // 空闲时插话就是开始一轮
    }
    this.turnCount++
    const ordinal = this.turnCount
    this.step = 0
    const turn = turnId(ordinal)
    const userStep = stepId(turn, 1)
    this.step = 1
    this.push([
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn',
          turnId: turn,
          ordinal,
          state: 'running',
          origin: { kind: 'user' },
          prompt: input.text,
        },
      },
      {
        op: 'step.upsert',
        turnId: turn,
        step: { kind: 'step', stepId: userStep, turnId: turn, ordinal: 1, state: 'completed' },
      },
      /* 人话只在轮头（与 engine-omp 的两条投影同形）：另发一条没有 origin 的用户帧，两条路的帧就对不上了 */
    ])
    this.maybeAutoTitle(input)
    this.setState('running')
    const steps = this.o.script(input, ordinal - 1)
    // 立即返回：真正的执行在下一拍（C-SUBMIT-RETURNS-EARLY）
    this.o.clock.setTimeout(() => {
      void this.run(steps, turn, ordinal, input.text)
    }, 0)
  }

  /** `prompt` 要带到每一次 turn.upsert 上：轮头是整头替换，收尾时漏了它，开轮那句话就从屏幕上消失 */
  private async run(steps: readonly ScenarioStep[], turn: string, ordinal: number, prompt: string): Promise<void> {
    for (const step of steps) {
      if (this.disposed) return
      if (step.kind === 'fail') {
        this.push([
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: turn,
              ordinal,
              state: 'failed',
              origin: { kind: 'user' },
              prompt,
            },
          },
        ])
        this.setState('idle', { code: step.code, message: step.message })
        return
      }
      const ops = await this.apply(step, turn, ordinal)
      this.push(ops)
    }
    if (this.disposed) return
    this.push([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: turn, ordinal, state: 'completed', origin: { kind: 'user' }, prompt },
      },
    ])
    this.setState('idle')
    /* 轮终再报一次上下文（与真引擎的 agent_end 同序：先收轮，再报读数）。 */
    this.reportContextUsage()
  }

  private async apply(step: ScenarioStep, turn: string, ordinal: number): Promise<TranscriptOperation[]> {
    switch (step.kind) {
      case 'text':
      case 'thinking': {
        // 用户消息占了第 1 段，助手内容从第 2 段起
        if (this.step <= 1) this.step = 2
        const at = stepId(turn, this.step)
        const frame = frameId(at, 1)
        const out: TranscriptOperation[] = [
          {
            op: 'step.upsert',
            turnId: turn,
            step: { kind: 'step', stepId: at, turnId: turn, ordinal: this.step, state: 'running' },
          },
        ]
        out.push({
          op: 'frame.upsert',
          turnId: turn,
          stepId: at,
          frame:
            step.kind === 'text'
              ? { kind: 'text', frameId: frame, text: '', role: 'assistant' }
              : { kind: 'thinking', frameId: frame, text: '' },
        })
        // 分两段推送：让上层的增量拼接被真实覆盖
        const half = Math.ceil(step.text.length / 2)
        const head = step.text.slice(0, half)
        const tail = step.text.slice(half)
        out.push({
          op: 'append',
          target: { type: 'frame', turnId: turn, stepId: at, frameId: frame },
          offset: 0,
          text: head,
        })
        if (tail.length > 0) {
          out.push({
            op: 'append',
            target: { type: 'frame', turnId: turn, stepId: at, frameId: frame },
            offset: head.length,
            text: tail,
          })
        }
        return out
      }
      case 'tool':
        return await this.runTool(step.name, step.args, step.result, turn)
      case 'interaction': {
        const request = {
          ...step.interaction,
          id: createId(),
          createdAt: this.o.clock.now(),
          timeoutAt: null,
        } as Interaction
        this.outstanding.push(request)
        this.emit({ type: 'interactionRequested', interaction: request })
        this.setState('awaiting')
        const answer = await new Promise<InteractionAnswer>((resolve) => this.pending.set(request.id, resolve))
        this.pending.delete(request.id)
        this.outstanding.splice(this.outstanding.indexOf(request), 1)
        this.emit({ type: 'interactionResolved', interactionId: request.id })
        if (!this.disposed) this.setState('running')
        return [{ op: 'interaction.upsert', interaction: interactionCardOf(request, { answer }) }]
      }
      case 'usage': {
        const usage: UsageSample = { ...step.usage, at: this.o.clock.now() }
        this.emit({ type: 'usage', usage })
        /*
         * 真引擎在同一处（message_end）也重报一次上下文用量，替身跟着报：
         * 少了这一步，conversation core 那条转发就永远测不到（它原先正是漏的）。
         */
        this.emit({ type: 'contextUsage', usage: this.o.contextUsage() })
        return []
      }
      case 'file':
        /* 轮号是时间线那个 ordinal（从 1 起），不是 turnId 字符串 */
        this.emit({ type: 'fileChanged', turn: ordinal, path: step.path, before: step.before, after: step.after })
        return []
      case 'fail':
        // fail 在 run() 里直接结束这一轮，不会走到这里
        return []
    }
  }

  /** 问一次权限：挂起等答复，收下之后把它从 outstanding 里摘掉 */
  private async requestApproval(name: string, args: unknown): Promise<InteractionAnswer> {
    const request: Interaction = {
      id: createId(),
      kind: 'approval',
      tool: name,
      title: `允许使用工具：${name}`,
      detail: JSON.stringify(args ?? {}),
      allowSessionScope: true,
      createdAt: this.o.clock.now(),
      timeoutAt: null,
    }
    this.outstanding.push(request)
    this.emit({ type: 'interactionRequested', interaction: request })
    this.setState('awaiting')
    const answer = await new Promise<InteractionAnswer>((resolve) => this.pending.set(request.id, resolve))
    this.pending.delete(request.id)
    this.outstanding.splice(this.outstanding.indexOf(request), 1)
    this.emit({ type: 'interactionResolved', interactionId: request.id })
    if (!this.disposed) this.setState('running')
    return answer
  }

  private async runTool(name: string, args: unknown, fallback: string, turn: string): Promise<TranscriptOperation[]> {
    this.step++
    const at = stepId(turn, this.step)
    const frame = frameId(at, 1)
    const spec = this.o.tools.get(name)
    let text = fallback
    let isError = false
    let approved = true
    if (spec !== undefined && needsApproval(this.posture, spec.approval) && !this.granted.has(name)) {
      const answer = await this.requestApproval(name, args)
      approved = answer.kind === 'approval' && answer.decision === 'approve'
      if (approved && answer.kind === 'approval' && answer.scope === 'session') this.granted.add(name)
    }
    if (spec !== undefined && isBusyOrNot(approved)) {
      text = '用户拒绝'
      isError = true
    } else if (spec !== undefined) {
      const parsed = spec.parameters.safeParse(args)
      const params = parsed.success ? parsed.data : args
      const outcome = await spec.execute(params as never, {
        cwd: this.o.spec.cwd,
        signal: new AbortController().signal,
        sessionKey: this.o.spec.key,
      })
      text = outcome.text
      this.o.toolCalls.push({ sessionKey: this.o.spec.key, name, params, result: text })
    }
    return [
      {
        op: 'step.upsert',
        turnId: turn,
        step: { kind: 'step', stepId: at, turnId: turn, ordinal: this.step, state: 'running' },
      },
      {
        op: 'frame.upsert',
        turnId: turn,
        stepId: at,
        frame: {
          kind: 'tool',
          frameId: frame,
          toolCallId: createId(),
          name,
          state: isError ? 'error' : 'done',
          input: args,
          output: text,
          ...(isError ? { error: text } : {}),
        },
      },
    ]
  }

  async cancel(): Promise<void> {
    this.assertLive()
    for (const [id, settle] of [...this.pending]) {
      settle({ kind: 'dismiss' })
      this.emit({ type: 'interactionResolved', interactionId: id })
      this.pending.delete(id)
    }
    this.outstanding.length = 0
    if (this.current !== 'idle') this.setState('idle')
  }

  queue(): QueueSnapshot {
    return {
      items: this.ledger.map((e) => ({
        id: e.id,
        text: e.text,
        deliverAs: e.deliverAs,
        createdAt: e.createdAt,
        ...(e.ref === undefined ? {} : { ref: e.ref }),
      })),
      modes: { ...this.modes },
    }
  }

  withdraw(queueItemId: string): void {
    const at = this.ledger.findIndex((e) => e.id === queueItemId)
    if (at < 0) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    const [entry] = this.ledger.splice(at, 1)
    this.emit({ type: 'queue', queue: this.queue() })
    if (entry?.ref !== undefined) this.emit({ type: 'queueSettled', ref: entry.ref, outcome: 'withdrawn' })
  }

  /**
   * 换层：取出该项、改层、换新 id、放到队尾（与真引擎同一条语义 —— 排队的唯一主人在账本里，换层不重新展开输入）。
   */
  async moveQueued(queueItemId: string, deliverAs: 'steer' | 'followUp'): Promise<void> {
    const at = this.ledger.findIndex((e) => e.id === queueItemId)
    if (at < 0) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    const [entry] = this.ledger.splice(at, 1)
    if (entry === undefined) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    this.ledger.push({ ...entry, id: createId(), deliverAs })
    this.emit({ type: 'queue', queue: this.queue() })
  }

  setQueueModes(modes: Partial<QueueSnapshot['modes']>): void {
    Object.assign(this.modes, modes)
    this.emit({ type: 'queue', queue: this.queue() })
  }

  controls(): Controls {
    return {
      model: {
        current: this.model,
        choices:
          this.model === null
            ? []
            : [{ ref: this.model, label: `${this.model.provider}/${this.model.id}`, reasoning: true, images: true }],
      },
      thinking: {
        current: this.thinking,
        choices: this.thinking === null ? [] : [{ id: this.thinking, label: this.thinking }],
      },
      posture: this.posture,
      planMode: this.planMode,
      goal: this.goal?.objective ?? null,
      goalSnapshot:
        this.goal === null
          ? null
          : {
              objective: this.goal.objective,
              completionCriterion: null,
              status: this.goal.status,
              turnsUsed: 0,
              tokensUsed: 0,
              wallClockMs: 0,
            },
      available: { plan: true, goal: true },
      context: null,
    }
  }

  private controlsChanged(): void {
    this.emit({ type: 'controls', controls: this.controls() })
  }

  private reportContextUsage(): void {
    this.emit({ type: 'contextUsage', usage: this.o.contextUsage() })
  }

  async setModel(model: ModelRef): Promise<void> {
    this.assertLive()
    this.model = model
    this.controlsChanged()
  }

  setThinking(level: string): void {
    this.assertLive()
    this.thinking = level
    this.controlsChanged()
  }

  setPosture(posture: Posture): void {
    this.assertLive()
    this.posture = posture
    this.controlsChanged()
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    this.assertLive()
    this.planMode = enabled
    this.controlsChanged()
  }

  async setGoal(goal: string | null): Promise<void> {
    this.assertLive()
    if (goal === null) {
      this.goal = null
    } else if (this.goal === null) {
      this.goal = { objective: goal, status: 'active' }
    } else {
      /* 只换正文，不动状态（与真引擎同一条，R-10） */
      this.goal = { objective: goal, status: this.goal.status }
    }
    this.controlsChanged()
  }

  async pauseGoal(): Promise<void> {
    this.assertLive()
    if (this.goal === null) throw new AppError(SystemErrorCode.notFound, '这条对话没有进行中的目标')
    if (this.goal.status === 'paused') return
    this.goal = { objective: this.goal.objective, status: 'paused' }
    this.controlsChanged()
  }

  async resumeGoal(): Promise<void> {
    this.assertLive()
    if (this.goal === null) throw new AppError(SystemErrorCode.notFound, '这条对话没有已暂停的目标')
    if (this.goal.status === 'active') return
    this.goal = { objective: this.goal.objective, status: 'active' }
    this.controlsChanged()
  }

  async commands(): Promise<readonly SlashCommand[]> {
    this.assertLive()
    return FAKE_COMMANDS
  }

  /** 与真引擎同一条端口语义：只在 idle 时可调；本地命令出一段文字、收尾补一条 timelineReset 与一条 contextUsage；交给 agent 的开一轮 */
  async runCommand(text: string): Promise<void> {
    this.assertLive()
    if (this.current !== 'idle') throw new AppError(EngineErrorCode.busy, 'agent 正忙')
    const [name = '', verb = ''] = text.trim().slice(1).split(/\s+/)
    /* 与真引擎同一条拦截：删会话文件走 threads.delete，不走命令 */
    const blocked = name === 'session' && verb === 'delete'
    const command = blocked ? undefined : FAKE_COMMANDS.find((candidate) => candidate.name === name)
    if (command === undefined) throw new AppError(EngineErrorCode.commandUnknown, `没有这条命令：/${name}`)
    if (command.name === 'retry') {
      await this.submit({ text, images: [], files: [], skills: [], deliverAs: 'turn' })
      return
    }
    this.setState('running')
    this.emit({ type: 'commandOutput', text: `${command.name}: ok`, tone: 'success' })
    this.emit({ type: 'timelineReset', agentId: 'main' })
    /* 本地命令（压缩、瘦身）改了上下文却不走轮终：收口补报一次占用，与真引擎同序 */
    this.emit({ type: 'contextUsage', usage: this.o.contextUsage() })
    this.setState('idle')
  }

  interactions(): readonly Interaction[] {
    return [...this.outstanding]
  }

  respond(interactionId: string, answer: InteractionAnswer): void {
    this.assertLive()
    const settle = this.pending.get(interactionId)
    if (settle === undefined) {
      throw new AppError(EngineErrorCode.interactionExpired, '该请求已失效')
    }
    settle(answer)
  }

  async page(agentId: string, beforeTurnId: string | null): Promise<TranscriptPage> {
    return pageOfOps(this.ops, agentId, beforeTurnId)
  }

  /* 替身没有子代理与后台作业：三条都按「不在运行」答，形状与真引擎一致（false / subagent_not_running） */
  async cancelSubagent(_agentId: string): Promise<boolean> {
    this.assertLive()
    return false
  }

  async steerSubagent(agentId: string, text: string): Promise<void> {
    this.assertLive()
    if (text.trim() === '') throw new AppError(SystemErrorCode.invalidParams, '引导的话不能为空')
    throw new AppError(EngineErrorCode.subagentNotRunning, `这个子代理已经结束了：${agentId}`)
  }

  async cancelBackgroundTask(_taskId: string): Promise<boolean> {
    this.assertLive()
    return false
  }

  // ── 侧边提问（omp 的 /btw）：不碰时间线、不改 state、不跑工具 ─────────────────
  private sideTopicsOf(): SideTopic[] {
    return this.o.sides.get(this.sessionFile) ?? []
  }

  private writeSideTopic(topic: SideTopic): void {
    const others = this.sideTopicsOf().filter((held) => held.id !== topic.id)
    this.o.sides.set(this.sessionFile, [...others, topic])
  }

  private patchSideTurn(run: SideRun, patch: Partial<SideTurn>): SideTopic | null {
    const topic = this.sideTopicsOf().find((held) => held.id === run.topicId)
    const turn = topic?.turns[run.turn]
    if (topic === undefined || turn === undefined) return null
    const next: SideTopic = {
      ...topic,
      turns: topic.turns.map((held, index) => (index === run.turn ? { ...turn, ...patch } : held)),
    }
    this.writeSideTopic(next)
    return next
  }

  async askSide(question: string, topicId: string | null): Promise<SideTopic> {
    this.assertLive()
    const text = question.trim()
    if (text === '') throw new AppError(SystemErrorCode.invalidParams, '侧边提问不能为空')
    if (this.side !== null) throw new AppError(EngineErrorCode.sideBusy, '上一个侧边提问还没答完')
    const previous = topicId === null ? undefined : this.sideTopicsOf().find((topic) => topic.id === topicId)
    if (topicId !== null && previous === undefined) {
      throw new AppError(EngineErrorCode.sideTopicUnknown, `找不到这个侧边话题：${topicId}`)
    }
    const now = this.o.clock.now()
    const turn: SideTurn = {
      question: text,
      answer: '',
      status: 'running',
      createdAt: now,
      updatedAt: now,
      error: null,
    }
    const topic: SideTopic =
      previous === undefined
        ? { id: `side-${createId()}`, leafId: this.ops.length === 0 ? null : `leaf-${this.turnCount}`, turns: [turn] }
        : { ...previous, turns: [...previous.turns, turn] }
    this.writeSideTopic(topic)
    const run: SideRun = { topicId: topic.id, turn: topic.turns.length - 1, cancelled: false }
    this.side = run
    this.emit({ type: 'sideTopic', topic })
    /* 脚本按「下一轮怎么答」取一份：只认正文与 fail，工具 / 交互一律不跑（omp 的一次性回合从不执行工具） */
    const steps = this.o.script({ text, images: [], files: [], skills: [], deliverAs: 'turn' }, SIDE_TURN_INDEX)
    /* 与 omp 同序：先交回开问的快照，答案从下一拍起才流出 */
    this.o.clock.setTimeout(() => {
      void this.answerSide(run, steps).catch(() => undefined)
    }, 0)
    return topic
  }

  private async answerSide(run: SideRun, steps: readonly ScenarioStep[]): Promise<void> {
    let answer = ''
    for (const step of steps) {
      if (run.cancelled || this.disposed) return
      if (step.kind === 'fail') {
        this.finishSide(run, { status: 'error', error: step.message })
        return
      }
      if (step.kind !== 'text') continue
      const offset = answer.length
      answer += step.text
      this.patchSideTurn(run, { answer, updatedAt: this.o.clock.now() })
      this.emit({ type: 'sideDelta', topicId: run.topicId, turn: run.turn, offset, delta: step.text })
      /* 每一截之间让出一拍：停止键要有机会插进来 */
      await new Promise<void>((resolve) => {
        this.o.clock.setTimeout(resolve, 0)
      })
    }
    if (run.cancelled || this.disposed) return
    this.finishSide(run, { status: 'complete' })
  }

  /** 收口只做一次：之后同一问再有结局（停止与答完撞车）一律不认 */
  private finishSide(run: SideRun, patch: Partial<SideTurn>): void {
    if (this.side !== run) return
    this.side = null
    const topic = this.patchSideTurn(run, { ...patch, updatedAt: this.o.clock.now() })
    if (topic !== null) this.emit({ type: 'sideTopic', topic })
  }

  cancelSide(topicId: string | null): boolean {
    const run = this.side
    if (run === null || (topicId !== null && run.topicId !== topicId)) return false
    run.cancelled = true
    this.finishSide(run, { status: 'cancelled' })
    return true
  }

  async sideTopics(): Promise<readonly SideTopic[]> {
    this.assertLive()
    return newestFirst(this.sideTopicsOf())
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    /* 与 omp 的 RpcBtwController.close 同序：先停掉在答的那一问并落账，再关会话 */
    this.cancelSide(null)
    this.disposed = true
    for (const [, settle] of this.pending) settle({ kind: 'dismiss' })
    this.pending.clear()
    this.outstanding.length = 0
  }
}

/** 替身认的档位（omp 的档位全序；`off` 不是「一档」） */
const FAKE_THINKING_LEVELS: readonly string[] = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** 替身的角色表：omp MODEL_ROLES 的前几格（chat 区三格 + kind 区一格），够覆盖「两区」与「未知角色」两件事 */
const FAKE_ROLES: readonly { role: string; name: string; section: 'chat' | 'kind' }[] = Object.freeze([
  { role: 'default', name: 'Default', section: 'chat' },
  { role: 'smol', name: 'Fast', section: 'chat' },
  { role: 'tiny', name: 'Tiny', section: 'chat' },
  { role: 'image', name: 'Image generation', section: 'kind' },
])

/** 替身的命令表：只放一致性用例用得到的那几条（形状与 omp 折算出来的一致）。
 *  `session` 是本地命令（只出一段文字），`retry` 交给 agent（开一轮）—— 两种结局各有一条可测。 */
const FAKE_COMMANDS: readonly SlashCommand[] = Object.freeze([
  {
    name: 'compact',
    aliases: [],
    description: 'Compact the conversation',
    hint: '[focus]',
    source: 'builtin',
    subcommands: [],
  },
  {
    name: 'retry',
    aliases: [],
    description: 'Retry the last failed agent turn',
    hint: null,
    source: 'builtin',
    subcommands: [],
  },
  {
    name: 'session',
    aliases: [],
    description: 'Show or configure the current session',
    hint: null,
    source: 'builtin',
    subcommands: [],
  },
])

function isBusyOrNot(approved: boolean): boolean {
  return !approved
}

export function createFakeEngine(opts: FakeEngineOptions = {}): FakeEngine {
  const clock = opts.clock ?? systemClock
  const script = opts.script ?? defaultScript
  const tools = new Map<string, EngineToolSpec>()
  const opened: OpenSessionSpec[] = []
  const toolCalls: FakeToolCall[] = []
  const prompts: FakePrompt[] = []
  const sessions = new Set<FakeSession>()
  const store: SessionLedger = new Map()
  const sides: SideLedger = new Map()
  const sessionNames = new Map<string, string>()
  let frozen = false
  const change = new Emitter<void>()
  let providers: ProviderInfoValue[] = []
  /** 账号登录过的服务商 → 账号（OAuth 凭据的替身；API Key 不在这里） */
  const signedIn = new Map<string, string>()
  let models: ModelInfoValue[] = []
  let settings: SettingDescriptorValue[] = []
  let skills: SkillInfoValue[] = []
  let mcpServers: McpServerInfoValue[] = []
  /** 在线目录（Smithery）的替身内容，注入式：真实现要起网络，默认空表。 */
  const mcpCatalog: McpCatalogEntryValue[] = [...(opts.mcpCatalog ?? [])]
  let plugins: PluginInfoValue[] = []
  let capabilities: CapabilitiesValue = { computerUse: false, browserControl: false }
  let defaultModelRef: ModelRef | null = null
  /** 默认选择器里显式写的那一档（omp 的 `modelRoles.default` 的 `:档位` 后缀） */
  let defaultSuffix: string | null = null
  let defaultThinkingLevel: string | null = null
  /** 只有新会话默认值变了（ModelsPort.onDidChangeDefaults） */
  const defaultsChange = new Emitter<void>()
  /** 模型角色（omp 的 modelRoles）：替身只认这几格，没配 = 不在表里 */
  const roleSelectors = new Map<string, string>()
  /** 当前设置的 Python 解释器（PY-1 断言写入的那一格）。 */
  let pythonInterpreter: string | null = null
  const pythonInterpreterCalls: (string | null)[] = []

  const engine: FakeEngine = {
    info: { name: 'omp', version: 'fake' } satisfies EngineInfo,
    /* 替身不跑 relay 服务：browser 功能的 Core 模块据此回 port: null，Host 那一侧就不去连 */
    browserRelay: () => null,
    opened,
    pythonInterpreterCalls,
    sessionNames,
    /*
     * 草稿控件表（方案 §04 的 draftControls）：只读，不开会话、不写设置。与会话里那份同一条规则：
     * 可选模型来自目录（只取 enabled），思考档位按当前模型的 thinkingLevels 给，姿态是 init.posture ?? 'auto-edit'。
     */
    /*
     * 与真引擎同一条规则：入口页的命令表不列只对已有对话有意义的那几条（这里是 compact 与 retry）；
     * 没开着的对话（options.history）列全 —— 替身的会话没有扩展命令，冷表与活表因此同一张。
     */
    async commandCatalog(_cwd, options) {
      if (options?.history === true) return FAKE_COMMANDS
      return FAKE_COMMANDS.filter((command) => command.name !== 'compact' && command.name !== 'retry')
    },
    async draftControls(init) {
      /* 与真引擎同一规矩：只有没给模型时才套默认选择器里的档位 */
      const explicit = init?.model ?? null
      const current = explicit ?? defaultModelRef
      const suffix = explicit === null ? defaultSuffix : null
      const posture = init?.posture ?? 'auto-edit'
      return {
        model: {
          current: current ?? null,
          choices: models
            .filter((m) => m.enabled)
            .map((m) => ({
              ref: { provider: m.provider, id: m.id },
              label: m.name,
              reasoning: m.reasoning,
              images: m.vision,
            })),
        },
        thinking: {
          current: init?.thinking ?? suffix ?? defaultThinkingLevel,
          choices: (opts.thinkingLevels ?? []).map((level) => ({ id: level, label: level })),
        },
        posture,
        planMode: false,
        goal: null,
        available: { plan: true, goal: true },
        context: null,
      }
    },
    /* 一致性套件用得到：草稿表里那个 alias 有没有被算错。 */
    draftAliasOf: (m) => (m === null ? null : `${m.provider}/${m.id}`),
    toolCalls,
    prompts,
    registerTool(spec) {
      if (frozen) throw new AppError(EngineErrorCode.toolsFrozen, '工具注册已关闭')
      if (tools.has(spec.name)) throw new AppError(SystemErrorCode.conflict, '工具重名')
      tools.set(spec.name, spec)
      return toDisposable(() => tools.delete(spec.name))
    },
    freezeTools() {
      frozen = true
    },
    async openSession(spec) {
      if (!frozen) throw new AppError(EngineErrorCode.toolsFrozen, '工具注册尚未冻结')
      opened.push(spec)
      const session = new FakeSession({
        spec,
        script,
        tools,
        toolCalls,
        prompts,
        clock,
        store,
        sides,
        names: sessionNames,
        posture: spec.posture ?? opts.posture ?? 'ask',
        /* 没给就是 undefined：一次都不报，与真引擎「还没水合」同义。 */
        contextUsage: () => opts.contextUsage ?? null,
        ...(opts.autoTitle === undefined ? {} : { autoTitle: opts.autoTitle }),
      })
      /*
       * 与 OmpEngine 同一条登记规矩（R-05 §3.1）：会话池释放一条会话直接调它的 dispose()，不经过引擎 ——
       * 这里不包一层，替身自己也会只增不减，测试就可能替真实现遮错。
       */
      sessions.add(session)
      const original = session.dispose.bind(session)
      let disposing: Promise<void> | undefined
      return Object.assign(session, {
        dispose(): Promise<void> {
          disposing ??= original().finally(() => {
            sessions.delete(session)
          })
          return disposing
        },
      })
    },
    sessionFiles: {
      async exists(file) {
        return store.has(file)
      },
      /* 与 FakeSession.page 同一个产地（pageOfOps）：冷读与「重开再 page()」交出同一页，正是端口要的那条一致性 */
      async readPage(file, agentId, beforeTurnId) {
        const ops = store.get(file)
        if (ops === undefined) throw new AppError(EngineErrorCode.sessionFileMissing, `会话文件不存在：${file}`)
        return pageOfOps(ops, agentId, beforeTurnId)
      },
      /* 与 FakeSession.sideTopics 同一本账、同一条次序：冷读与「重开再问」同一张表 */
      async sideTopics(file) {
        return newestFirst(sides.get(file) ?? [])
      },
      async fork(file, keepTurns, title) {
        const next = `${file}.fork-${createId()}`
        /* 与真引擎同一条边界：0 合法（一轮不留），负数与非整数报 invalid_params */
        if (keepTurns !== undefined && (!Number.isInteger(keepTurns) || keepTurns < 0)) {
          throw new AppError(SystemErrorCode.invalidParams, `不能只留前 ${keepTurns} 轮`)
        }
        store.set(next, [...(store.get(file) ?? [])])
        /* omp 的分叉连 artifacts 一起复制：侧边话题跟着过去 */
        const topics = sides.get(file)
        if (topics !== undefined) sides.set(next, [...topics])
        const name = title === undefined ? sessionNames.get(file) : title.trim()
        if (name !== undefined && name !== '') sessionNames.set(next, name)
        return { sessionId: createId(), sessionFile: next }
      },
      async rename(file, title) {
        if (!store.has(file)) throw new AppError(EngineErrorCode.sessionFileMissing, `会话文件不存在：${file}`)
        const name = title.trim()
        if (name === '') throw new AppError(SystemErrorCode.invalidParams, '会话名不能为空')
        sessionNames.set(file, name)
      },
      async delete(file) {
        store.delete(file)
        sides.delete(file)
      },
      async exportHtml(file, outFile) {
        store.set(outFile, [...(store.get(file) ?? [])])
      },
      async exportMarkdown() {
        return '# 会话\n'
      },
      /* 分享链接是测试替身造的确定值：会话不在时报同一条 session_file_missing，不真的上传 */
      async share(file) {
        if (!store.has(file)) throw new AppError(EngineErrorCode.sessionFileMissing, `会话文件不存在：${file}`)
        return { url: `https://share.example/${encodeURIComponent(file)}#test-key`, truncated: false }
      },
      async collectGarbage() {
        return { deletedFiles: 0, freedBytes: 0, errors: [] }
      },
    },
    models: {
      async providers() {
        return providers
      },
      async models() {
        return models
      },
      async setApiKey(id) {
        providers = providers.map((p) => (p.id === id ? { ...p, configured: true } : p))
        change.fire()
      },
      async clearApiKey(id) {
        providers = providers.map((p) => (p.id === id ? { ...p, configured: false } : p))
        change.fire()
      },
      /* 账号登录：每一家内置服务商都假装能登；流程与 omp 的回环登录同形 —— 先给网址，再要一格授权码，填了才算登上 */
      async loginProviders() {
        return providers
          .filter((p) => !p.custom)
          .map((p) => ({
            id: p.id,
            name: p.name,
            provider: p.id,
            available: true,
            authenticated: signedIn.has(p.id),
            account: signedIn.get(p.id) ?? null,
            issuesApiKey: false,
          }))
      },
      async logout(providerId) {
        if (!signedIn.delete(providerId)) return
        providers = providers.map((p) => (p.id === providerId ? { ...p, configured: false } : p))
        change.fire()
      },
      async login(providerId, io) {
        if (!providers.some((p) => p.id === providerId && !p.custom)) {
          throw new AppError(SystemErrorCode.invalidParams, `不支持用账号登录：${providerId}`)
        }
        io.onAuth({ url: `https://login.example/${providerId}`, launchUrl: null, code: null, instructions: null })
        io.onProgress('等待授权')
        const code = await io.onPrompt({
          message: '授权码',
          placeholder: null,
          secret: false,
          allowEmpty: false,
          fallback: false,
        })
        if (io.signal.aborted) throw new AppError(SystemErrorCode.cancelled, '登录已取消')
        if (code === '') throw new AppError(SystemErrorCode.invalidParams, '没有填授权码')
        signedIn.set(providerId, 'fake@example.com')
        providers = providers.map((p) => (p.id === providerId ? { ...p, configured: true } : p))
        change.fire()
        return { kind: 'oauth' as const, email: 'fake@example.com', orgName: null }
      },
      async setModelEnabled(ref, enabled) {
        models = models.map((m) => (m.provider === ref.provider && m.id === ref.id ? { ...m, enabled } : m))
        change.fire()
      },
      async defaultModel() {
        return defaultModelRef
      },
      async defaultSelection() {
        return { model: defaultModelRef, thinking: defaultModelRef === null ? null : defaultSuffix }
      },
      async setDefaultModel(ref, thinking) {
        if (typeof thinking === 'string' && !FAKE_THINKING_LEVELS.includes(thinking)) {
          throw new AppError(SystemErrorCode.invalidParams, `unknown thinking level: ${thinking}`)
        }
        defaultModelRef = ref
        /* 省略 = 保留原后缀（只换模型），null = 去掉 */
        if (thinking !== undefined) defaultSuffix = thinking
        defaultsChange.fire()
      },
      async defaultThinking() {
        return defaultThinkingLevel
      },
      async setDefaultThinking(level) {
        defaultThinkingLevel = level
        defaultsChange.fire()
      },
      /* 角色：候选是目录里 enabled 的那些（真引擎问 omp 的 roleCandidatePool），清单取 omp 内置的前几格 */
      async modelRoles() {
        const candidates = models
          .filter((m) => m.enabled)
          .map((m) => ({ selector: `${m.provider}/${m.id}`, label: m.name }))
        return FAKE_ROLES.map(({ role, name, section }) => ({
          role,
          name,
          description: null,
          section,
          selector: roleSelectors.get(role) ?? null,
          candidates,
          /* 去向不在这里仿 omp 的回退链：一律交「自动」，挑不挑得出看有没有候选 */
          fallback: { kind: 'auto' as const, model: candidates[0]?.label ?? null },
        }))
      },
      async setModelRole(role, selector) {
        if (!FAKE_ROLES.some((r) => r.role === role)) {
          throw new AppError(SystemErrorCode.invalidParams, `unknown model role: ${role}`)
        }
        if (selector === null || selector === '') roleSelectors.delete(role)
        else roleSelectors.set(role, selector)
        if (role === 'default') defaultsChange.fire()
        else change.fire()
      },
      async upsertCustomProvider(def: CustomProviderDef) {
        providers = [
          ...providers.filter((p) => p.id !== def.id),
          { id: def.id, name: def.name, configured: true, custom: true, authKind: 'api_key', docsUrl: null },
        ]
        change.fire()
      },
      async removeCustomProvider(id) {
        providers = providers.filter((p) => p.id !== id)
        change.fire()
      },
      onDidChange: change.event,
      onDidChangeDefaults: defaultsChange.event,
    },
    settings: {
      groupOrder: [],
      async catalog() {
        return settings
      },
      async set(path, value) {
        settings = settings.map((s) => (s.path === path ? { ...s, value } : s))
        change.fire()
      },
      async reset(path) {
        settings = settings.map((s) => (s.path === path ? { ...s, value: s.defaultValue } : s))
        change.fire()
      },
      async capabilities() {
        return capabilities
      },
      async setCapability(name, enabled) {
        capabilities = { ...capabilities, [name]: enabled }
        change.fire()
      },
      async getPythonInterpreter() {
        return pythonInterpreter
      },
      async setPythonInterpreter(exePath) {
        pythonInterpreter = exePath
        pythonInterpreterCalls.push(exePath)
        change.fire()
      },
      onDidChange: (listener) => change.event(() => listener({ paths: [] })),
    },
    skills: {
      async list() {
        return skills
      },
      async setEnabled(id, enabled) {
        skills = skills.map((s) => (s.id === id ? { ...s, enabled } : s))
      },
      async installFromDirectory(dir) {
        const skill: SkillInfoValue = { id: dir, name: dir, description: '', source: 'user', enabled: true, path: dir }
        skills = [...skills, skill]
        return skill
      },
      async installFromZip(zipFile) {
        return engine.skills.installFromDirectory(zipFile)
      },
      async forget(id) {
        skills = skills.filter((s) => s.id !== id)
      },
      async read() {
        return { markdown: '' }
      },
    },
    mcp: {
      async list() {
        return mcpServers
      },
      async upsert(server) {
        mcpServers = [...mcpServers.filter((s) => s.name !== server.name), server]
      },
      async remove(name) {
        mcpServers = mcpServers.filter((s) => s.name !== name)
      },
      async status(): Promise<McpStatusValue[]> {
        return []
      },
      /* 在线目录检索的替身：按标题/说明做大小写不敏感的子串过滤，与 omp 的语义同形但不起网络。
       * 空关键词返回空数组（真实现同样不查）。 */
      async catalog(query) {
        const needle = query.trim().toLowerCase()
        if (needle === '') return []
        return mcpCatalog.filter(
          (entry) => entry.title.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle),
        )
      },
      onDidChangeStatus: () => toDisposable(() => undefined),
    },
    plugins: {
      async list() {
        return plugins
      },
      async marketplace(): Promise<MarketplaceEntryValue[]> {
        return []
      },
      async install(id) {
        const plugin: PluginInfoValue = {
          id,
          name: id,
          version: '0.0.0',
          description: '',
          enabled: true,
          source: 'market',
        }
        plugins = [...plugins, plugin]
        return plugin
      },
      async uninstall(id) {
        plugins = plugins.filter((p) => p.id !== id)
      },
      async setEnabled(id, enabled) {
        plugins = plugins.map((p) => (p.id === id ? { ...p, enabled } : p))
      },
    },
    async dispose() {
      await Promise.all([...sessions].map((session) => session.dispose()))
      sessions.clear()
      change.dispose()
      defaultsChange.dispose()
    },
  }
  return engine
}
