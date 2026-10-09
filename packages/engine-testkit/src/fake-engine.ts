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
  type MarketplaceEntry,
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
  type SkillInfo,
  type SubmitInput,
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
type PluginInfoValue = z.infer<typeof PluginInfo>
type MarketplaceEntryValue = z.infer<typeof MarketplaceEntry>

export interface FakeEngineOptions {
  readonly script?: ScenarioScript
  readonly clock?: Clock
  /** OpenSessionSpec 没给 posture 时用它 */
  /**
   * 草稿控件表要报的思考档位（`draftControls` 的 thinking.choices）。
   *
   * omp 的档位梯子是**按模型**烤在目录里的（Model.thinking.efforts），FakeEngine 的模型
   * 表没有那一格，所以档位改从这里注入 —— 一致性套件的 C-DRAFT-CONTROLS 两个引擎都
   * 用同一组档位，比的是「草稿表怎么组装」而不是「档位从哪来」。
   */
  readonly thinkingLevels?: readonly string[]
  readonly posture?: Posture
  /**
   * 上下文用量那一格的报数（替身没有真会话，omp 的 getContextUsage 无处可读，只能注入）。
   *
   * 报**null 也是有效报数**（「此刻没有可报的窗口」），所以这里默认 undefined = 一次都不报，
   * 与真引擎「还没水合」同义；给了值就按真引擎的时机报（每条 assistant 消息落地、轮终）。
   */
  readonly contextUsage?: ContextUsage | null
}

export interface FakeToolCall {
  readonly sessionKey: string
  readonly name: string
  readonly params: unknown
  readonly result: string
}

export interface FakeEngine extends AgentEngine {
  readonly opened: readonly OpenSessionSpec[]
  readonly toolCalls: readonly FakeToolCall[]
  /** `setPythonInterpreter` 收到的每次调用（含传 null 的解除）；python 的 onReady 判据据此断言。 */
  readonly pythonInterpreterCalls: readonly (string | null)[]
  /**
   * 草稿表里 current 的写法（provider/id），与 omp 侧 aliasOf 同一拼法。
   * 一致性套件比两个引擎的草稿表时用它，不在测试里各写一遍字符串拼接。
   */
  readonly draftAliasOf: (model: ModelRef | null) => string | null
}

const APPROVAL_TIER: Record<EngineToolSpec['approval'], number> = { read: 0, write: 1, exec: 2 }
const POSTURE_MAX: Record<Posture, number> = { ask: 0, 'auto-edit': 1, 'full-access': 2 }

/** 与 omp 的 APPROVAL_MODE_MAX_TIER 一致的放行规则（12 页 §5.3） */
function needsApproval(posture: Posture, approval: EngineToolSpec['approval']): boolean {
  return APPROVAL_TIER[approval] > POSTURE_MAX[posture]
}

/** 会话文件的账本：dispose 后重开同一个文件要能读回同样的内容（C-REOPEN） */
type SessionLedger = Map<string, TranscriptOperation[]>

class FakeSession implements EngineSession {
  readonly sessionId = `fake-${createId()}`
  readonly sessionFile: string
  private readonly listeners = new Set<(event: EngineSessionEvent) => void>()
  private readonly pending = new Map<string, (answer: InteractionAnswer) => void>()
  private readonly outstanding: Interaction[] = []
  private readonly granted = new Set<string>()
  private readonly ledger: { id: string; text: string; deliverAs: 'steer' | 'followUp'; createdAt: number }[] = []
  private readonly modes: QueueSnapshot['modes'] = { steer: 'all', followUp: 'all' }
  private ops: TranscriptOperation[]
  private current: SessionState = 'idle'
  private posture: Posture
  private model: ModelRef | null
  private thinking: string | null
  private planMode = false
  private goal: string | null = null
  private ordinal = 0
  private step = 0
  private turnCount = 0
  private disposed = false

  constructor(
    private readonly o: {
      readonly spec: OpenSessionSpec
      readonly script: ScenarioScript
      readonly tools: ReadonlyMap<string, EngineToolSpec>
      readonly toolCalls: FakeToolCall[]
      readonly clock: Clock
      readonly store: SessionLedger
      readonly posture: Posture
      readonly contextUsage: () => ContextUsage | null
    },
  ) {
    this.sessionFile = o.spec.sessionFile ?? `fake-${createId()}.jsonl`
    this.ops = [...(o.store.get(this.sessionFile) ?? [])]
    this.posture = o.spec.posture
    this.model = o.spec.model
    this.thinking = o.spec.thinking
    this.turnCount = this.ops.filter((op) => op.op === 'turn.upsert').length
  }

  state(): SessionState {
    return this.current
  }

  isBusy(): boolean {
    return this.current !== 'idle'
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
        // 监听器不抛异常（12 页 §0.3）
      }
    }
  }

  private setState(next: SessionState, error: { code: string; message: string } | null = null): void {
    if (this.current === next && error === null) return
    this.current = next
    this.emit({ type: 'state', state: next, error })
  }

  /** 记一笔时间线并推向订阅者 */
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
    if (this.current !== 'idle') {
      if (input.deliverAs === 'turn') throw new AppError(EngineErrorCode.busy, 'agent 正忙')
      this.ledger.push({ id: createId(), text: input.text, deliverAs: input.deliverAs, createdAt: this.o.clock.now() })
      this.emit({ type: 'queue', queue: this.queue() })
      return
    }
    if (input.deliverAs !== 'turn') {
      // 空闲时点“插话”就是开始一轮
    }
    this.turnCount++
    const ordinal = this.turnCount
    this.ordinal = ordinal
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
      {
        op: 'frame.upsert',
        turnId: turn,
        stepId: userStep,
        frame: { kind: 'text', frameId: frameId(userStep, 1), text: input.text, role: 'user' },
      },
    ])
    this.setState('running')
    const steps = this.o.script(input, ordinal - 1)
    // 立即返回：真正的执行在下一拍（C-SUBMIT-RETURNS-EARLY）
    this.o.clock.setTimeout(() => {
      void this.run(steps, turn, ordinal)
    }, 0)
  }

  private async run(steps: readonly ScenarioStep[], turn: string, ordinal: number): Promise<void> {
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
            },
          },
        ])
        this.setState('idle', { code: step.code, message: step.message })
        return
      }
      const ops = await this.apply(step, turn)
      this.push(ops)
    }
    if (this.disposed) return
    this.push([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: turn, ordinal, state: 'completed', origin: { kind: 'user' } },
      },
    ])
    this.setState('idle')
    /* 轮终再报一次上下文（与真引擎的 agent_end 同序：先收轮，再报读数）。 */
    this.reportContextUsage()
  }

  private async apply(step: ScenarioStep, turn: string): Promise<TranscriptOperation[]> {
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
        // 分两段推送：让上层的增量拼接被真实覆盖（12 页 §1.2）
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
        return [
          {
            op: 'interaction.upsert',
            interaction: {
              interactionId: request.id,
              interactionKind: request.kind === 'question' ? 'question' : 'approval',
              state:
                answer.kind === 'dismiss'
                  ? 'cancelled'
                  : answer.kind === 'confirm' && !answer.value
                    ? 'rejected'
                    : 'approved',
            },
          },
        ]
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
      case 'fail':
        // fail 在 run() 里直接结束这一轮，不会走到这里
        return []
    }
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
    return { items: this.ledger.map((e) => ({ ...e })), modes: { ...this.modes } }
  }

  withdraw(queueItemId: string): void {
    const at = this.ledger.findIndex((e) => e.id === queueItemId)
    if (at < 0) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    this.ledger.splice(at, 1)
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
      goal: this.goal,
      /** 替身没有 agent 设置文件，两档一律可用（真实现现读 plan.enabled / goal.enabled） */
      available: { plan: true, goal: true },
      context: null,
    }
  }

  private controlsChanged(): void {
    this.emit({ type: 'controls', controls: this.controls() })
  }

  /** 轮终的上下文重报（与真引擎的 agent_end 同一条：收尾也会动上下文）。 */
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
    this.goal = goal
    this.controlsChanged()
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

  async page(_agentId: string, beforeTurnId: string | null): Promise<TranscriptPage> {
    const state = applyOps(emptyTimeline(), this.ops)
    const page = pageFromState(state)
    if (beforeTurnId === null) return page
    const limit = Number(beforeTurnId.slice(1))
    return { ...page, items: page.items.filter((item) => item.kind !== 'turn' || item.ordinal < limit) }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const [, settle] of this.pending) settle({ kind: 'dismiss' })
    this.pending.clear()
    this.outstanding.length = 0
  }
}

/** 审批未通过：用一个小函数表达，避免把“拒绝”混进工具实现的成功路径 */
function isBusyOrNot(approved: boolean): boolean {
  return !approved
}

export function createFakeEngine(opts: FakeEngineOptions = {}): FakeEngine {
  const clock = opts.clock ?? systemClock
  const script = opts.script ?? defaultScript
  const tools = new Map<string, EngineToolSpec>()
  const opened: OpenSessionSpec[] = []
  const toolCalls: FakeToolCall[] = []
  const sessions = new Set<FakeSession>()
  const store: SessionLedger = new Map()
  let frozen = false
  const change = new Emitter<void>()
  let providers: ProviderInfoValue[] = []
  let models: ModelInfoValue[] = []
  let settings: SettingDescriptorValue[] = []
  let skills: SkillInfoValue[] = []
  let mcpServers: McpServerInfoValue[] = []
  let plugins: PluginInfoValue[] = []
  let capabilities: CapabilitiesValue = { computerUse: false, browserControl: false }
  let defaultModelRef: ModelRef | null = null
  let defaultThinkingLevel: string | null = null
  /** 当前设置的 Python 解释器（07 页 §13C 的 onReady 判据；PY-1 断言写入的那一格）。 */
  let pythonInterpreter: string | null = null
  /** `setPythonInterpreter` 收到的每一次调用（含传 null 的解除），供断言。 */
  const pythonInterpreterCalls: (string | null)[] = []

  const engine: FakeEngine = {
    info: { name: 'omp', version: 'fake' } satisfies EngineInfo,
    opened,
    pythonInterpreterCalls,
    /*
     * 草稿控件表（方案 §04 的 draftControls）：只读，不开会话、不写设置。
     *
     * 与会话里那份同一条规则：可选模型来自目录（只取 enabled），思考档位按当前模型
     * 的 thinkingLevels 给，姿态是 init.posture ?? 'auto-edit'。FakeEngine 的模型表
     * 没有 reasoning 的档位梯子，所以档位用 opts 里给的那一组（缺省空表）。
     */
    async draftControls(init) {
      const current = init?.model ?? defaultModelRef
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
          current: init?.thinking ?? defaultThinkingLevel,
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
        clock,
        store,
        posture: spec.posture ?? opts.posture ?? 'ask',
        /* 没给就是 undefined：一次都不报，与真引擎「还没水合」同义。 */
        contextUsage: () => opts.contextUsage ?? null,
      })
      sessions.add(session)
      return session
    },
    sessionFiles: {
      async exists(file) {
        return store.has(file)
      },
      async fork(file, undoTurns) {
        const next = `${file}.fork-${createId()}`
        store.set(next, [...(store.get(file) ?? [])])
        void undoTurns
        return { sessionId: createId(), sessionFile: next }
      },
      async delete(file) {
        store.delete(file)
      },
      async exportHtml(file, outFile) {
        store.set(outFile, [...(store.get(file) ?? [])])
      },
      async exportMarkdown() {
        return '# 会话\n'
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
      async setModelEnabled(ref, enabled) {
        models = models.map((m) => (m.provider === ref.provider && m.id === ref.id ? { ...m, enabled } : m))
        change.fire()
      },
      async defaultModel() {
        return defaultModelRef
      },
      async setDefaultModel(ref) {
        defaultModelRef = ref
        change.fire()
      },
      async defaultThinking() {
        return defaultThinkingLevel
      },
      async setDefaultThinking(level) {
        defaultThinkingLevel = level
        change.fire()
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
      for (const session of sessions) await session.dispose()
      sessions.clear()
      change.dispose()
    },
  }
  return engine
}
