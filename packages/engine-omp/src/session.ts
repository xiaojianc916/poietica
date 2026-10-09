import { readFileSync } from 'node:fs'
import {
  type ContextUsage,
  type Controls,
  EngineErrorCode,
  type EngineSession,
  type EngineSessionEvent,
  type Interaction,
  type InteractionAnswer,
  type ModelRef,
  type OpenSessionSpec,
  type Posture,
  type QueueSnapshot,
  type SessionState,
  type SubmitInput,
} from '@poietica/engine'
import { AppError, createId, Emitter, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { TranscriptOperation, TranscriptPage } from '@poietica/transcript'
import { outcomeOf, toEngineError } from './errors'
import type { InteractionBroker } from './interactions/broker'
import type { LiveProjector } from './projector/live'
import type { SkillPromptMessage } from './prompt'
import { usageOf } from './usage'

/**
 * 把 SubmitInput 的图片读成 data URL（附件条目要的就是它）。
 * 读不出来的图片跳过：它仍然会随正文送进模型（prompt.ts 那条路），只是这一帧画不出预览。
 */
function readImageDataUrls(
  images: readonly { readonly path: string; readonly mime: string }[],
): { attachmentId: string; mediaType: string; dataUrl: string }[] {
  const out: { attachmentId: string; mediaType: string; dataUrl: string }[] = []
  for (const [index, image] of images.entries()) {
    try {
      const bytes = readFileSync(image.path)
      out.push({
        attachmentId: `${createId()}#${String(index)}`,
        mediaType: image.mime,
        dataUrl: `data:${image.mime};base64,${bytes.toString('base64')}`,
      })
    } catch {
      // 读不到就只画正文：投递那条路会如实报错
    }
  }
  return out
}

/**
 * transcript 的 `interactionKind` 三档。上游只认 approval / question，`plan` 是线上形状
 * 那一层放出来的（04 页 §3.12 第 5 支要求计划卡片在时间线上有一席之地）。
 */
function interactionKindOf(interaction: Interaction): 'approval' | 'question' | 'plan' {
  if (interaction.kind === 'question') return 'question'
  if (interaction.kind === 'plan') return 'plan'
  return 'approval'
}

/** 答复 → 卡片终态。dismiss（含超时与 abort）一律 cancelled；确认类按 true/false 分 */
function resolvedStateOf(
  _interaction: Interaction,
  answer: InteractionAnswer | undefined,
): 'approved' | 'rejected' | 'cancelled' | 'answered' {
  if (answer === undefined || answer.kind === 'dismiss') return 'cancelled'
  if (answer.kind === 'approval') return answer.decision === 'approve' ? 'approved' : 'rejected'
  /* 计划三档与卡片终态逐档对应：批准 / 要求修改（答了这一档）/ 否决 */
  if (answer.kind === 'plan') {
    if (answer.decision === 'approve') return 'approved'
    return answer.decision === 'revise' ? 'answered' : 'rejected'
  }
  if (answer.kind === 'confirm') return answer.value ? 'approved' : 'rejected'
  return 'answered'
}

/** OmpSession 需要的最小 omp 会话面（细节由 session-factory 注入，会话自己不认识 omp 类型） */
export interface OmpSessionHost {
  readonly spec: OpenSessionSpec
  readonly logger: Logger
  readonly broker: InteractionBroker
  readonly projector: LiveProjector
  readonly prompt: (input: SubmitInput, skillMessage: SkillPromptMessage | null) => Promise<boolean>
  readonly steer: (
    text: string,
    input: SubmitInput,
    deliverAs: 'steer' | 'followUp',
    skillMessage: SkillPromptMessage | null,
  ) => Promise<void>
  readonly abort: () => Promise<void>
  readonly disposeSession: () => Promise<void>
  readonly queueOf: () => { readonly steering: readonly string[]; readonly followUp: readonly string[] }
  readonly popLastQueued: () => boolean
  readonly clearQueue: () => void
  readonly setQueueMode: (kind: 'steer' | 'followUp', value: 'all' | 'one-at-a-time') => void
  readonly setApprovalMode: (posture: Posture) => void
  readonly grantTool: (tool: string) => void
  /**
   * 会话此刻正在用的模型（读 omp 的 `session.model`）。还没选出来时是 null。
   *
   * 12 页 §7.7 的表：model 那一格**读 `session.model`** —— 不是读构造入参。
   * 差别在 SDK 自己挑模型时：spec 里没有（`null = 使用默认模型`），而会话真跑起来
   * 时 omp 自己选了一条，控件表要报的是后者（真机实测：报构造入参会把空 ref 发上屏，
   * 契约当场退回）。同理 thinking 读 `session.thinkingLevel`。
   */
  readonly liveModel: () => ModelRef | null
  readonly liveThinking: () => string | null
  readonly lastAssistant: () => { readonly stopReason?: string; readonly errorMessage?: string } | undefined
  /**
   * 会话此刻的上下文用量（读数 + 构成）。算不出就是 null（窗口未知 / omp 还没水合）。
   *
   * 现读，不缓存：非消息四项 omp 自己按 settings revision 与数组身份记忆化（见适配器那一头）。
   */
  readonly contextUsage: () => ContextUsage | null
  /** 该模型自己的思考档位梯子（omp 的 getAvailableThinkingLevels） */
  readonly thinkingChoices: () => readonly string[]
  /**
   * 会话此刻的**模型候选**（omp 的 `getAvailableModels()` 映射成控件形状）。
   *
   * 与 `thinkingChoices` 同一条规矩：现读会话自己的清单，不是写死一条。label 用模型
   * 自己的名字（`model.name ?? model.id`，与 legacy 的选择器同一拼法），不是 provider/id。
   */
  readonly modelChoices: () => readonly {
    readonly ref: ModelRef
    readonly label: string
    readonly reasoning: boolean
    readonly images: boolean
  }[]
  /** 一条模型在界面上的名字（当前这一条不在候选清单里时补一条要用它） */
  readonly modelLabel: (model: ModelRef) => string
  /** 该模型**静态**的思考档位梯子：会话还没水合、omp 报空时用它补一份 */
  readonly thinkingFallback: (model: ModelRef | null) => readonly string[]
  /** 该模型声明的默认档；都没有就是 null（不编一档） */
  readonly defaultThinking: (model: ModelRef | null) => string | null
  /** 把模型切到这一条（omp 的 setModel；不落盘、不动全局默认） */
  readonly setModelOnSession: (model: ModelRef) => Promise<void>
  /** 把思考档位切到这一档（omp 的 setThinkingLevel） */
  readonly setThinkingOnSession: (level: string) => void
  /** 展开这一句挂的技能为 omp 的自定义消息（omp 的 buildSkillPromptMessage；要读 SKILL.md，所以是异步） */
  readonly skillMessage: (input: SubmitInput) => Promise<SkillPromptMessage | null>
  /**
   * 计划模式与目标模式的真实接线（04 §2.4 / 12 §7.7）。
   *
   * 这两格不是「本地记一下就完」：omp 按会话状态收起工具集、把 plan/goal 工具塞回活动集、
   * 把模式上下文注入对话。具体实现住在 `plan-goal.ts`，会话只负责持状态与重报控件。
   */
  readonly applyPlanMode: (enabled: boolean) => Promise<void>
  readonly applyGoal: (goal: string | null) => Promise<void>
  /** 这两档此刻能不能用（现读 agent 设置；UI 据此隐藏选择器） */
  readonly planAvailable: () => boolean
  readonly goalAvailable: () => boolean
  /** 会话此刻的计划模式状态（omp 的 getPlanModeState） */
  readonly livePlanMode: () => boolean
  /** 会话此刻的目标正文（omp 的 getGoalModeState；没有就是 null） */
  readonly liveGoal: () => string | null
  /** 会话此刻的目标快照（状态 / 用量 / 秒针）；没有就是 null */
  readonly liveGoalSnapshot: () => import('@poietica/engine').SessionGoalSnapshot | null
  readonly page: (agentId: string, beforeTurnId: string | null) => Promise<TranscriptPage>
  readonly now: () => number
}

interface QueueEntry {
  readonly id: string
  readonly text: string
  readonly deliverAs: 'steer' | 'followUp'
  readonly createdAt: number
  /** 原始输入：撤回其余项时要按「原顺序、原图片、原技能」重投（12 页 §7.5） */
  readonly input: SubmitInput
}

/**
 * OmpSession（12 页 §7）：把 omp 的 AgentSession 包装成 EngineSession。
 *
 * 状态机只有三格（idle → running ⇄ awaiting），只在 setState 里改，改完立刻 emit；状态相同时不重复发出。
 * 队列账本自己记：omp 的 getQueuedMessages() 只回文本数组、没有 id，而端口要求队列项有稳定 id（UI 用它做撤回和 key）。
 */
export class OmpSession implements EngineSession {
  readonly sessionId: string
  readonly sessionFile: string
  private readonly events = new Emitter<EngineSessionEvent>()
  private readonly ledger: QueueEntry[] = []
  private readonly modes: QueueSnapshot['modes'] = { steer: 'all', followUp: 'all' }
  private readonly subscriptions: { dispose(): void }[] = []
  private stateValue: SessionState = 'idle'
  private postureValue: Posture
  private modelRef: ModelRef | null
  private thinkingValue: string | null
  private disposed = false

  constructor(
    private readonly o: OmpSessionHost,
    ids: { readonly sessionId: string; readonly sessionFile: string },
  ) {
    this.sessionId = ids.sessionId
    this.sessionFile = ids.sessionFile
    this.postureValue = o.spec.posture
    this.modelRef = o.spec.model
    this.thinkingValue = o.spec.thinking
  }

  /** 会话建好之后接上订阅（构造时 omp 对象还不完整） */
  attach(subscriptions: readonly { dispose(): void }[]): void {
    this.subscriptions.push(...subscriptions)
  }

  state(): SessionState {
    return this.stateValue
  }

  isBusy(): boolean {
    return this.stateValue !== 'idle'
  }

  subscribe(listener: (event: EngineSessionEvent) => void): { dispose(): void } {
    return this.events.event(listener)
  }

  private emit(event: EngineSessionEvent): void {
    if (this.disposed) return
    this.events.fire(event)
  }

  private setState(next: SessionState, error: { code: string; message: string } | null = null): void {
    if (this.stateValue === next && error === null) return
    this.stateValue = next
    this.emit({ type: 'state', state: next, error })
  }

  private timeline(ops: readonly TranscriptOperation[]): void {
    if (ops.length > 0) this.emit({ type: 'timeline', agentId: 'main', ops })
  }

  /** broker 变化：待答交互数决定 running 与 awaiting 的来回切（12 页 §7.2） */
  onPendingCountChanged(pendingCount: number): void {
    if (pendingCount > 0 && this.stateValue === 'running') this.setState('awaiting')
    else if (pendingCount === 0 && this.stateValue === 'awaiting') this.setState('running')
  }

  async submit(input: SubmitInput): Promise<void> {
    this.assertLive()
    if (this.stateValue !== 'idle') {
      if (input.deliverAs === 'turn') throw new AppError(EngineErrorCode.busy, 'agent 正忙')
      await this.enqueue(input, input.deliverAs)
      return
    }
    // 12 页 §7.4 第 3 步：每张图片先落一条 attachment.upsert，再开轮（投影层按号查附件）。
    // SubmitInput.images 只给磁盘路径，像素在这里读成 data URL（与 prompt.ts 读的是同一批文件）。
    const images = readImageDataUrls(input.images)
    if (images.length > 0) {
      this.timeline(
        images.flatMap((image) =>
          this.o.projector.attachmentOp({
            attachmentId: image.attachmentId,
            mediaType: image.mediaType,
            dataUrl: image.dataUrl,
          }),
        ),
      )
    }
    this.timeline(
      this.o.projector.userTurn({
        text: input.text,
        skills: input.skills,
        ...(images.length === 0 ? {} : { attachmentIds: images.map((i) => i.attachmentId) }),
      }),
    )
    this.setState('running')
    // 不 await：一轮会挂在交互上，submit 必须立即返回（C-SUBMIT-RETURNS-EARLY）
    void this.runTurn(input)
  }

  private async runTurn(input: SubmitInput): Promise<void> {
    try {
      // 没挂技能时不 await（保持同步投递）：submit 之后的第一个同步刻度就该看到 prompt 已经发出
      const skillMessage = input.skills.length === 0 ? null : await this.skillTextFor(input)
      const delivered = await this.o.prompt(input, skillMessage)
      if (!delivered) {
        // omp 没有把这条输入交给模型（例如被扩展拦截）：以 completed 收掉这个空轮
        this.timeline(this.o.projector.turnEnd('completed', null))
        this.setState('idle')
      }
    } catch (error) {
      const mapped = toEngineError(error)
      this.timeline(this.o.projector.turnEnd('failed', mapped.message))
      this.setState('idle', { code: mapped.code, message: mapped.message })
    }
  }

  /**
   * 展开这一句挂的技能为 omp 的自定义消息（要读 SKILL.md，所以是异步）。
   *
   * 展开失败**必须让这一轮收成 failed**：乐观帧（userTurn）已经上屏了，而这一轮还没有
   * 任何东西能关掉它 —— 吞掉异常就是屏幕上那一轮永远转下去（legacy 同一处也是这么兜的）。
   */
  private async skillTextFor(input: SubmitInput): Promise<SkillPromptMessage | null> {
    return await this.o.skillMessage(input)
  }

  private async enqueue(input: SubmitInput, deliverAs: 'steer' | 'followUp'): Promise<void> {
    const skillMessage = input.skills.length === 0 ? null : await this.skillTextFor(input)
    await this.o.steer(input.text, input, deliverAs, skillMessage)
    // 登记待认领：omp 把这条折进上下文时会发 message_start，那时把它画成一句人话
    this.rememberInjection(input.text)
    this.ledger.push({ id: createId(), text: input.text, deliverAs, createdAt: this.o.now(), input })
    this.emitQueue()
  }

  private emitQueue(): void {
    this.emit({ type: 'queue', queue: this.queue() })
  }

  /**
   * 与 omp 的队列对账：两类分别按账本顺序做多重集匹配（同样的文本可以出现多次）。
   * 账本里有、omp 里已没有的项说明已经投递，从账本移除。
   */
  reconcileQueue(steering: readonly string[], followUp: readonly string[]): void {
    const pools = new Map<'steer' | 'followUp', string[]>([
      ['steer', [...steering]],
      ['followUp', [...followUp]],
    ])
    const keep: QueueEntry[] = []
    for (const entry of this.ledger) {
      const pool = pools.get(entry.deliverAs) ?? []
      const at = pool.indexOf(entry.text)
      if (at >= 0) {
        pool.splice(at, 1)
        keep.push(entry)
      }
    }
    this.ledger.length = 0
    this.ledger.push(...keep)
    this.emitQueue()
  }

  async cancel(): Promise<void> {
    this.assertLive()
    this.o.broker.cancelAll()
    await this.o.abort()
    if (this.stateValue !== 'idle') this.setState('idle')
  }

  queue(): QueueSnapshot {
    return { items: this.ledger.map((e) => ({ ...e })), modes: { ...this.modes } }
  }

  withdraw(queueItemId: string): void {
    const at = this.ledger.findIndex((entry) => entry.id === queueItemId)
    if (at < 0) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    const entry = this.ledger[at]!
    const sameKind = this.ledger.filter((e) => e.deliverAs === entry.deliverAs)
    const isLast = sameKind.at(-1)?.id === entry.id
    if (isLast) {
      this.o.popLastQueued()
    } else {
      // omp 只提供“弹出最后一项”与“全部清空”两个操作；任意撤回要靠清空后重投其余项
      const others = this.ledger.filter((e) => e.id !== entry.id)
      this.o.clearQueue()
      // 重投连同原图片与原技能（12 页 §7.5）：丢掉它们等于用户那句话少了一半
      for (const other of others) void this.o.steer(other.text, other.input, other.deliverAs, null)
    }
    this.ledger.splice(at, 1)
    this.emitQueue()
  }

  setQueueModes(modes: Partial<QueueSnapshot['modes']>): void {
    Object.assign(this.modes, modes)
    if (modes.steer !== undefined) this.o.setQueueMode('steer', modes.steer)
    if (modes.followUp !== undefined) this.o.setQueueMode('followUp', modes.followUp)
    this.emitQueue()
  }

  controls(): Controls {
    /*
     * 现读会话此刻的真相（liveModel），读不到才退回这一层记下的那一份。
     *
     * 「读不到」是一条真实的路：会话刚建好、SDK 还没选出模型时 `session.model` 是
     * undefined，而 setModel 记下的那份此时就是唯一已知的值。反过来，SDK 自己挑了
     * 一条时只有 liveModel 知道 —— 两条都要认，顺序不能反。
     */
    const current = this.o.liveModel() ?? this.modelRef
    /*
     * 候选是**这一家 agent 的全部可用模型**（omp 的 getAvailableModels，label 用模型
     * 自己的名字）。先前这里只造当前这一条、label 写成 provider/id：屏幕上就看不到模型
     * 名字、也换不了别条（真实故障 —— 用户报「显示的是模型 id 而不是模型名称」）。
     *
     * 当前那一条不在候选里时补一条进去（会话自己挑的模型可能不在白名单里）；label 走
     * host 给的写法，与候选里那一条同一拼法。
     */
    const offered = this.o.modelChoices()
    const choices =
      current === null ||
      offered.some((choice) => choice.ref.provider === current.provider && choice.ref.id === current.id)
        ? [...offered]
        : [
            {
              ref: current,
              label: this.o.modelLabel(current),
              reasoning: true,
              images: true,
            },
            ...offered,
          ]
    return {
      model: { current, choices },
      thinking: this.thinkingControls(current),
      posture: this.postureValue,
      /*
       * 计划与目标都**现读会话此刻的真相**（与 model / thinking 同一条规矩）：
       * 模型自己收尾、或人在别处改了模式时，只有会话知道；本地不再存第二份。
       */
      planMode: this.o.livePlanMode(),
      goal: this.o.liveGoal(),
      goalSnapshot: this.o.liveGoalSnapshot(),
      available: { plan: this.o.planAvailable(), goal: this.o.goalAvailable() },
      context: this.o.contextUsage(),
    }
  }

  /**
   * 思考那一格。
   *
   * **梯子与选中值都要在没有会话真相时也能答得出来**：会话刚建好、omp 还没水合，
   * `getAvailableThinkingLevels()` 与 `thinkingLevel` 都是空的 —— 照原样报出去，屏幕上
   * 就是「模型卡片里没有思考强度，切换一次之后才长出来」（真实故障）。这里的规矩与
   * entry 页的 draft-controls 同一条：
   *
   *   - 候选：会话现报的梯子优先；它空着时退回**这条模型静态的梯子**（模型目录里烤好的
   *     `thinking.efforts`）。两条都空才是「这条模型没有可控档位面」，此时才是空表。
   *   - 选中值：会话现报的档位 → 这一层记下的那一份 → 模型声明的默认档。
   *
   * 不编四档：任何一条来源都没有就如实交空表，与 12 页 §7.7 同一条规矩。
   */
  private thinkingControls(model: ModelRef | null): Controls['thinking'] {
    const live = this.o.thinkingChoices()
    const choices = live.length > 0 ? live : this.o.thinkingFallback(model)
    const current = this.o.liveThinking() ?? this.thinkingValue ?? this.o.defaultThinking(model)
    return {
      current,
      /* label 就是档位原文：卡的版式自己把首字母大写（session-controls.tsx 的 labelOf），
       * 而档位名是 agent 报的原文，产品不翻译它。 */
      choices: choices.map((level) => ({ id: level, label: level })),
    }
  }

  private emitControls(): void {
    this.emit({ type: 'controls', controls: this.controls() })
  }

  /** omp 自己改的模型/档位/目标也要让 UI 知道（事件订阅里调用） */
  controlsChanged(): void {
    this.emitControls()
  }

  /*
   * 改模型：**真的把它交给会话**（omp 的 setModel），不是只改本地那一格。
   *
   * 先前这里只写 `this.modelRef` —— 屏幕上报的与实际在跑的就是两条：用户选了 B，会话
   * 仍拿 A 答（真实故障「输入框显示的模型与我用的模型不一样」）。local 那一份仍然记，
   * 因为 omp 的 `session.model` 在切换落地前可能还是旧值，`controls()` 需要它兜底。
   */
  async setModel(model: ModelRef): Promise<void> {
    this.assertLive()
    await this.o.setModelOnSession(model)
    this.modelRef = model
    this.emitControls()
  }

  /** 改档位：同样真的交给会话（omp 的 setThinkingLevel），本地那一份只做兜底 */
  setThinking(level: string): void {
    this.assertLive()
    this.o.setThinkingOnSession(level)
    this.thinkingValue = level
    this.emitControls()
  }

  setPosture(posture: Posture): void {
    this.assertLive()
    this.postureValue = posture
    this.o.setApprovalMode(posture)
    this.emitControls()
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    this.assertLive()
    /*
     * 关掉计划模式时先把还在等的计划卡片按 dismiss 兑现（产品负责人 2026-10-07 定稿）：
     * 卡片留在屏幕上等人答复，而模式已经退出 —— 那一轮就永远收不了尾。
     */
    if (!enabled) {
      for (const interaction of this.o.broker.pending()) {
        if (interaction.kind === 'plan') this.o.broker.answer(interaction.id, { kind: 'dismiss' })
      }
    }
    await this.o.applyPlanMode(enabled)
    this.emitControls()
  }

  async setGoal(goal: string | null): Promise<void> {
    this.assertLive()
    await this.o.applyGoal(goal)
    this.emitControls()
  }

  interactions(): readonly Interaction[] {
    return this.o.broker.pending()
  }

  respond(interactionId: string, answer: InteractionAnswer): void {
    this.assertLive()
    if (answer.kind === 'approval' && answer.decision === 'approve' && answer.scope === 'session') {
      const request = this.o.broker.pending().find((entry) => entry.id === interactionId)
      if (request?.kind === 'approval') this.o.grantTool(request.tool)
    }
    this.o.broker.answer(interactionId, answer)
  }

  async page(agentId: string, beforeTurnId: string | null): Promise<TranscriptPage> {
    this.assertLive()
    return await this.o.page(agentId, beforeTurnId)
  }

  /**
   * 接上 broker 的变化（12 页 §7.3 第 3 点 + §8.6）：转发 interactionRequested / interactionResolved、
   * 把卡片 upsert 上屏、按待答数调整状态。由 session-factory 在 omp 会话建好后调用一次。
   */
  attachBroker(): { dispose(): void } {
    return this.o.broker.onChange((change) => {
      if (change.type === 'requested') {
        this.emit({ type: 'interactionRequested', interaction: change.interaction })
        this.interactionOp({
          interactionId: change.interaction.id,
          kind: interactionKindOf(change.interaction),
          state: 'pending',
          request: change.interaction,
        })
      } else {
        this.emit({ type: 'interactionResolved', interactionId: change.interaction.id })
        this.interactionOp({
          interactionId: change.interaction.id,
          kind: interactionKindOf(change.interaction),
          state: resolvedStateOf(change.interaction, change.answer),
          response: change.answer,
        })
      }
      this.onPendingCountChanged(this.o.broker.pendingCount())
    })
  }

  /**
   * 插话落地（迁移自 legacy bridge 的 claimedInjection）：omp 把注入的消息折进上下文时发 message_start，
   * 正文与我投出去还没认领的那一条对上，就把它画成一句人话（开着一轮进当前 step，没开着就自己开一轮）。
   * 返回 false 表示认不出 —— 场面上什么都没发生（开场白也走 message_start，不能误认）。
   */
  claimInjection(text: string): boolean {
    const at = this.injected.indexOf(text)
    if (at < 0) return false
    this.injected.splice(at, 1)
    this.timeline(this.o.projector.steeredFrame(text))
    return true
  }

  /** 投出去还没被认领的插话正文 */
  private readonly injected: string[] = []

  /** 投递一条插话时登记（adapter 在 steer / followUp 成功后调用） */
  rememberInjection(text: string): void {
    this.injected.push(text)
  }

  /**
   * 交互上屏（12 页 §8.6）：requested 时 pending，resolved 时终态（approved / rejected / cancelled / answered）。
   * 映射归这里，不归 broker —— broker 不认识 transcript。
   */
  interactionOp(input: {
    readonly interactionId: string
    readonly kind: 'approval' | 'question' | 'plan'
    readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed'
    readonly request?: unknown
    readonly response?: unknown
  }): void {
    this.emit({
      type: 'timeline',
      agentId: 'main',
      ops: [
        {
          op: 'interaction.upsert',
          interaction: {
            interactionId: input.interactionId,
            /*
             * `plan` 是线上形状那一层放宽出来的第三档（contract/wire.ts 的
             * `WireInteractionKind`）：上游的 `TranscriptInteraction` 只认 approval / question
             * （逐字节迁自 legacy），所以这里如实留一个窄化断言，而不是把上有的类型改掉。
             */
            interactionKind: input.kind as 'approval' | 'question',
            state: input.state,
            ...(input.request === undefined ? {} : { request: input.request }),
            ...(input.response === undefined ? {} : { response: input.response }),
          },
        },
      ],
    })
  }

  requestTimeline(ops: readonly TranscriptOperation[]): void {
    this.timeline(ops)
  }

  emitPromptDropped(text: string): void {
    this.emit({ type: 'promptDropped', text })
  }

  timelineReset(agentId: string): void {
    this.emit({ type: 'timelineReset', agentId })
  }

  /** 一轮结束（omp 的 agent_end）：结局由最后一条 assistant 消息决出 */
  finishTurn(): void {
    const outcome = outcomeOf(this.o.lastAssistant())
    this.timeline(this.o.projector.turnEnd(outcome.outcome, outcome.message))
    if (this.o.broker.pendingCount() === 0) {
      this.setState(
        'idle',
        outcome.message === null ? null : { code: EngineErrorCode.upstream, message: outcome.message },
      )
    }
  }

  /** 每一条 assistant 消息的用量（12 页 §11.3） */
  emitUsageFrom(message: Parameters<typeof usageOf>[0]): void {
    const sample = usageOf(message, this.o.now())
    if (sample !== null) this.emit({ type: 'usage', usage: sample })
  }

  /**
   * 上下文圆环那一格的重报。
   *
   * 时机与 legacy 逐条对齐（bridge.ts 的 reportUsage）：**每条 assistant 消息落地**一次、
   * **轮终**再一次。前者让数字跟着一轮里的每一步走（工具结果也在涨上下文），后者兜住
   * 「最后一条消息之后上下文又变了」——压缩、图片落地都发生在消息之间。
   *
   * 不接流式 delta：token 不随 delta 落库、分类也不动（legacy 同一条判据）。
   */
  reportContextUsage(): void {
    this.emit({ type: 'contextUsage', usage: this.o.contextUsage() })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const subscription of this.subscriptions) subscription.dispose()
    this.o.broker.cancelAll()
    try {
      await this.o.disposeSession()
    } catch (error) {
      this.o.logger.warn('omp session dispose failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    this.events.dispose()
  }

  private assertLive(): void {
    if (this.disposed) throw new AppError(SystemErrorCode.cancelled, '会话已关闭')
  }
}
