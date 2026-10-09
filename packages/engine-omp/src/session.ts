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
import { outcomeOf, type TurnOutcome, toEngineError } from './errors'
import { describeError } from './event-faults'
import type { InteractionBroker } from './interactions/broker'
import type { LiveProjector } from './projector/live'
import { type SkillPromptMessage, wireTextOf } from './prompt'
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
  /** 排队 / 插话投递。返回 omp 队列里这一项的正文（对账与 removeQueued 都认它） */
  readonly steer: (
    input: SubmitInput,
    deliverAs: 'steer' | 'followUp',
    skillMessage: SkillPromptMessage | null,
  ) => Promise<{ readonly wireText: string }>
  readonly abort: () => Promise<void>
  readonly disposeSession: () => Promise<void>
  readonly queueOf: () => { readonly steering: readonly string[]; readonly followUp: readonly string[] }
  /** 按正文从 omp 的某一个队列里移除一项；返回 false 表示 omp 里已经没有它（已被消费） */
  readonly removeQueued: (wireText: string, deliverAs: 'steer' | 'followUp') => boolean
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
  /** 显示正文：用户原话（队列行、插话帧都画它） */
  readonly text: string
  /** 投递正文：与 omp 队列对账、removeQueued、message_start 认领都用它 */
  readonly wireText: string
  /** 以技能消息投递（omp 发的是 custom 消息，不是 user 消息） */
  readonly skill: boolean
  readonly deliverAs: 'steer' | 'followUp'
  readonly createdAt: number
  /** 原始输入：换层时原样重新入队 */
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
  /** 已被 omp 从队列里取走、还没等到 message_start 的项（只在这一次运行内有效） */
  private readonly consumed: QueueEntry[] = []
  /** 本轮自己的 prompt：第一条对上的 message_start 不是插话 */
  private ownPrompt: { readonly kind: 'user'; readonly wireText: string } | { readonly kind: 'skill' } | null = null
  /** 队列变更串行链：enqueue / moveQueued 都挂在它后面 */
  private mutation: Promise<void> = Promise.resolve()
  private readonly modes: QueueSnapshot['modes'] = { steer: 'all', followUp: 'all' }
  private readonly subscriptions: { dispose(): void }[] = []
  private stateValue: SessionState = 'idle'
  /**
   * `agent_end` 到达时还有待答交互：记下结局，等交互全部答完再收成 idle（R-02 §2.7 第 3 条）。
   *
   * 不记的话那一轮永远收不了尾：等用户答完，`onPendingCountChanged` 把它切回 running，
   * 然后再也没有人把它变成 idle —— 屏幕上就是「答完了还在转、停止也没用」。
   */
  private endedWithPending: { readonly error: { code: string; message: string } | null } | null = null
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
    /* 转为 idle：这一次运行结束了，不会再有属于它的 message_start —— 等认领的项（含
     * abort 时被 omp 丢弃的队列项）在这里作废，否则它们会在下一轮里认领出重复气泡。 */
    if (next === 'idle') {
      this.consumed.length = 0
      this.ownPrompt = null
    }
    this.emit({ type: 'state', state: next, error })
  }

  private timeline(ops: readonly TranscriptOperation[]): void {
    if (ops.length > 0) this.emit({ type: 'timeline', agentId: 'main', ops })
  }

  /** broker 变化：待答交互数决定 running 与 awaiting 的来回切（12 页 §7.2） */
  onPendingCountChanged(pendingCount: number): void {
    /*
     * 这一轮在 `agent_end` 时还挂着交互（R-02 §2.7 第 3 条）：交互答完这一格就该收成 idle。
     * 顺序上必须**先于**切回 running 那一支 —— 切回 running 之后就再也没人把它变回 idle 了。
     */
    if (pendingCount === 0 && this.endedWithPending !== null) {
      const { error } = this.endedWithPending
      this.endedWithPending = null
      this.setState('idle', error)
      return
    }
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
    // 新的一轮开始：上一轮留下的「等交互答完再收尾」标记作废
    this.endedWithPending = null
    this.setState('running')
    // 不 await：一轮会挂在交互上，submit 必须立即返回（C-SUBMIT-RETURNS-EARLY）
    void this.runTurn(input)
  }

  private async runTurn(input: SubmitInput): Promise<void> {
    try {
      // 没挂技能时不 await（保持同步投递）：submit 之后的第一个同步刻度就该看到 prompt 已经发出
      const skillMessage = input.skills.length === 0 ? null : await this.skillTextFor(input)
      this.ownPrompt = skillMessage === null ? { kind: 'user', wireText: wireTextOf(input) } : { kind: 'skill' }
      const delivered = await this.o.prompt(input, skillMessage)
      if (!delivered) {
        // omp 没有把这条输入交给模型（例如被扩展拦截）：以 completed 收掉这个空轮
        this.closeTurnAfterRun('completed', null, null)
      }
    } catch (error) {
      const mapped = toEngineError(error)
      this.closeTurnAfterRun('failed', mapped.message, { code: mapped.code, message: mapped.message })
    }
  }

  /**
   * `runTurn` 里的收尾：投影异常**只记日志再吞掉**。
   *
   * `runTurn` 是 `void` 调用的，收尾再往外抛就成了未处理的 rejection；而 `settleTurn` 的
   * `finally` 已经把累加器复位、状态也收成 idle，所以丢掉这一个异常是安全的。
   */
  private closeTurnAfterRun(
    outcome: TurnOutcome['outcome'],
    message: string | null,
    error: { code: string; message: string } | null,
  ): void {
    try {
      this.settleTurn(outcome, message, error)
    } catch (projectionError) {
      this.o.logger.warn('turn end projection failed', { error: describeError(projectionError) })
    }
  }

  /**
   * 一轮的收口（R-02 §2.7 原则 3）：① 轮头已关（尽力而为）→ ② 累加器已复位 → ③ 状态回到 idle。
   *
   * 顺序不能换：idle 事件一发出，订阅方就可能在同一个调用栈里投递下一条排队消息 ——
   * 复位必须在 `setState` 之前完成，轮头也要在 idle 之前发出（否则 UI 先看到空闲、再看到轮头关闭）。
   * `turnEnd` 抛出的异常会等 `finally` 跑完继续往外抛，由调用方记日志。
   */
  private settleTurn(
    outcome: TurnOutcome['outcome'],
    message: string | null,
    error: { code: string; message: string } | null,
  ): void {
    try {
      this.timeline(this.o.projector.turnEnd(outcome, message))
    } finally {
      // 投影成不成功都要复位：否则下一句话（或插话）会落进已经结束的那一轮
      this.o.projector.abandonTurn()
      if (this.o.broker.pendingCount() === 0) this.setState('idle', error)
      else this.endedWithPending = { error }
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

  /**
   * 入队一条排队 / 插话。串行：技能展开是异步的，两条同时展开时先发出的那条必须先进账本，
   * 否则账本顺序与 omp 队列顺序会错位。
   */
  private enqueue(input: SubmitInput, deliverAs: 'steer' | 'followUp'): Promise<void> {
    return this.serial(async () => {
      this.assertLive()
      const skillMessage = input.skills.length === 0 ? null : await this.skillTextFor(input)
      const { wireText } = await this.o.steer(input, deliverAs, skillMessage)
      this.ledger.push({
        id: createId(),
        text: input.text,
        wireText,
        skill: skillMessage !== null,
        deliverAs,
        createdAt: this.o.now(),
        input,
      })
      this.emitQueue()
    })
  }

  /** 队列变更的串行链（enqueue / moveQueued 挂在它后面；一次失败不阻断下一次） */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(work)
    this.mutation = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private emitQueue(): void {
    this.emit({ type: 'queue', queue: this.queue() })
  }

  /**
   * 与 omp 的队列对账：两类分别按账本顺序做多重集匹配（同样的文本可以出现多次）。
   * 账本里有、omp 里已没有的项说明已经投递 —— 搬进 `consumed`（等 message_start 认领），
   * 不直接丢弃：丢弃会让「已折进上下文」的那一句永远画不出来（12 页 §7.5）。
   */
  reconcileQueue(steering: readonly string[], followUp: readonly string[]): void {
    const pools = new Map<'steer' | 'followUp', string[]>([
      ['steer', [...steering]],
      ['followUp', [...followUp]],
    ])
    const keep: QueueEntry[] = []
    for (const entry of this.ledger) {
      const pool = pools.get(entry.deliverAs) ?? []
      const at = pool.indexOf(entry.wireText)
      if (at >= 0) {
        pool.splice(at, 1)
        keep.push(entry)
      } else {
        this.consumed.push(entry)
      }
    }
    this.ledger.length = 0
    this.ledger.push(...keep)
    this.emitQueue()
  }

  async cancel(): Promise<void> {
    this.assertLive()
    // 用户点了停止：这一轮由 abort 收口，等待交互答完再收尾的标记作废
    this.endedWithPending = null
    this.o.broker.cancelAll()
    await this.o.abort()
    if (this.stateValue !== 'idle') this.setState('idle')
  }

  queue(): QueueSnapshot {
    return { items: this.ledger.map((e) => ({ ...e })), modes: { ...this.modes } }
  }

  withdraw(queueItemId: string): void {
    this.assertLive()
    const at = this.ledger.findIndex((entry) => entry.id === queueItemId)
    if (at < 0) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    const [entry] = this.ledger.splice(at, 1)
    const removed = this.o.removeQueued(entry!.wireText, entry!.deliverAs)
    // omp 已经取走：它即将（或已经）上屏，留在 consumed 里等 message_start 认领
    if (!removed) this.consumed.push(entry!)
    this.emitQueue()
    if (!removed) throw new AppError(EngineErrorCode.queueItemConsumed, '这条消息已经交给 agent，撤不回来了')
  }

  async moveQueued(queueItemId: string, deliverAs: 'steer' | 'followUp'): Promise<void> {
    this.assertLive()
    const entry = this.ledger.find((e) => e.id === queueItemId)
    if (entry === undefined) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    if (entry.deliverAs === deliverAs) return
    // 已被消费会在 withdraw 里抛出，不会重复入队
    this.withdraw(queueItemId)
    await this.enqueue(entry.input, deliverAs)
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
   * 插话落地：omp 把一条 user 消息折进上下文（message_start）。本轮自己的 prompt 不画
   * （userTurn 已经画了），对得上队列项就画成一句人话；认不出（开场白、系统注入）什么也不画。
   */
  onUserMessageStart(wireText: string): void {
    const own = this.ownPrompt
    if (own !== null && own.kind === 'user' && own.wireText === wireText) {
      this.ownPrompt = null
      return
    }
    const entry = this.takeConsumed((e) => !e.skill && e.wireText === wireText)
    if (entry !== null) this.timeline(this.o.projector.steeredFrame(entry.text))
  }

  /** omp 把一条用户技能消息折进上下文。技能消息没有可靠的正文可对，按 FIFO 认领最早的技能项 */
  onSkillMessageStart(): void {
    if (this.ownPrompt?.kind === 'skill') {
      this.ownPrompt = null
      return
    }
    const entry = this.takeConsumed((e) => e.skill)
    if (entry !== null) this.timeline(this.o.projector.steeredFrame(entry.text))
  }

  /**
   * 先在 consumed 里找（queue_update 先到），再在 ledger 里找（message_start 先到）。
   * 从 ledger 里取走时要 emitQueue。都找不到返回 null。
   */
  private takeConsumed(match: (entry: QueueEntry) => boolean): QueueEntry | null {
    const c = this.consumed.findIndex(match)
    if (c >= 0) return this.consumed.splice(c, 1)[0] ?? null
    const l = this.ledger.findIndex(match)
    if (l < 0) return null
    const [entry] = this.ledger.splice(l, 1)
    this.emitQueue()
    return entry ?? null
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
    // 重复的 agent_end：轮已关、状态已空闲，再走一遍只会重复发 state 事件
    if (!this.o.projector.isTurnOpen && this.stateValue === 'idle') return
    let outcome: TurnOutcome
    try {
      outcome = outcomeOf(this.o.lastAssistant())
    } catch (error) {
      /*
       * 读不到结局：`agent_end` 本身就是 omp 的正常结束信号，按 completed 收并记日志（R-02 §2.7）。
       *
       * 不按 failed 收的理由：失败的只是我们这边读取结局的那一步，omp 自己已经正常结束了这一轮；
       * 标成 failed 会让定时任务记一次假失败、屏幕上也会出现一个红色的轮。真正的模型错误
       * 还有其它路径会报出来（runTurn 的 catch、auto_retry_end 的失败 notice）。
       */
      this.o.logger.warn('turn outcome unavailable', { error: describeError(error) })
      outcome = { outcome: 'completed', message: null }
    }
    this.settleTurn(
      outcome.outcome,
      outcome.message,
      outcome.message === null ? null : { code: EngineErrorCode.upstream, message: outcome.message },
    )
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
