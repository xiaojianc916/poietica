import {
  type ContextUsage,
  type Controls,
  EngineErrorCode,
  type EngineSession,
  type EngineSessionEvent,
  type Interaction,
  type InteractionAnswer,
  interactionCardOf,
  type ModelRef,
  type OpenSessionSpec,
  type Posture,
  type QueueOutcome,
  type QueueSnapshot,
  type SessionState,
  type SideTopic,
  type SlashCommand,
  type SubmitInput,
} from '@poietica/engine'
import { AppError, createId, Emitter, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { TranscriptInteraction, TranscriptOperation, TranscriptPage } from '@poietica/transcript'
import { outcomeOf, type TurnOutcome, toEngineError } from '../errors'
import { AskCallTracker } from '../interactions/ask-calls'
import type { InteractionBroker } from '../interactions/broker'
import type { FileAttachmentInput, ImageAttachmentInput, LiveProjector } from '../projector/live'
import type { MediaRef } from '../projector/media'
import { OpenTurnScreen, overlayOpenTurn } from '../projector/open-turn'
import { commandErrorOf, commandOutputOf } from './command-output'
import { describeError } from './event-faults'
import type { LoadedImage } from './prompt'
import { type SkillPromptMessage, wireTextOf } from './prompt'
import type { SideEvent, SideQuestions } from './side-questions'
import { type BuiltinCommandHooks, compactionActionOf, type runBuiltinCommand } from './slash-commands'
import { usageOf } from './usage'

/** OmpSession 需要的最小 omp 会话面（细节由 session-factory 注入，会话自己不认识 omp 类型） */
export interface OmpSessionHost {
  readonly spec: OpenSessionSpec
  readonly logger: Logger
  readonly broker: InteractionBroker
  readonly projector: LiveProjector
  /** 把 submit 的图片读进内存：只读一次，同时给时间线那一帧与 omp prompt；读失败原样抛错 */
  readonly loadImages: (
    images: readonly { readonly path: string; readonly mime: string }[],
  ) => Promise<readonly { readonly path: string; readonly mime: string; readonly base64: string }[]>
  /** 读好的图 → 时间线上的内容寻址地址；生产实现同时保证字节落在 omp 的 blob 目录（session/media-store.ts） */
  readonly mediaRef: MediaRef
  readonly promptWithImages: (
    input: SubmitInput,
    images: readonly { readonly path: string; readonly mime: string; readonly base64: string }[],
    skillMessage: SkillPromptMessage | null,
  ) => Promise<boolean>
  /**
   * 排队 / 插话投递；返回值是 omp 队列里这一项的正文（对账与 removeQueued 都认它）。
   * `images` 是已经读好的图（与插话帧上的图同一份像素，不再读第二遍）；不给就由实现自己读。
   */
  readonly steer: (
    input: SubmitInput,
    deliverAs: 'steer' | 'followUp',
    skillMessage: SkillPromptMessage | null,
    images?: readonly LoadedImage[],
  ) => Promise<{ readonly wireText: string }>
  readonly abort: () => Promise<void>
  readonly disposeSession: () => Promise<void>
  readonly queueOf: () => { readonly steering: readonly string[]; readonly followUp: readonly string[] }
  /** 按正文从 omp 的某个队列移除一项；返回 false 表示 omp 里已经没有它（已被消费） */
  readonly removeQueued: (wireText: string, deliverAs: 'steer' | 'followUp') => boolean
  readonly setQueueMode: (kind: 'steer' | 'followUp', value: 'all' | 'one-at-a-time') => void
  readonly setApprovalMode: (posture: Posture) => void
  readonly grantTool: (tool: string) => void
  /**
   * **读 `session.model`**，不是读构造入参：SDK 自己挑模型时 spec 里没有，而控件表要报会话真跑起来的
   * 那一条（真机实测：报构造入参会把空 ref 发上屏，契约当场退回）。thinking 同理。
   */
  readonly liveModel: () => ModelRef | null
  /** omp 的 sessionManager.setSessionName(name, 'user')；false = omp 拒收（空名 / 会话已释放） */
  readonly setSessionName: (name: string) => Promise<boolean>
  readonly liveThinking: () => string | null
  readonly lastAssistant: () => { readonly stopReason?: string; readonly errorMessage?: string } | undefined
  /** 会话此刻的上下文用量（读数 + 构成）；算不出就是 null（窗口未知 / omp 还没水合） */
  readonly contextUsage: () => ContextUsage | null
  /** 该模型自己的思考档位梯子（omp 的 getAvailableThinkingLevels） */
  readonly thinkingChoices: () => readonly string[]
  /** 会话此刻的模型候选（omp 的 `getAvailableModels()`）；与 thinkingChoices 同一条规矩：现读，不写死一条 */
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
  /** 展开这句挂的技能为 omp 的自定义消息（要读 SKILL.md，所以异步）；`images` 省略即由适配器自己读 */
  readonly skillMessage: (input: SubmitInput, images?: readonly LoadedImage[]) => Promise<SkillPromptMessage | null>
  /** 计划与目标模式的真实接线：omp 按会话状态收起工具集、把 plan/goal 工具塞回活动集，实现在 plan-goal.ts */
  readonly applyPlanMode: (enabled: boolean) => Promise<void>
  readonly applyGoal: (goal: string | null) => Promise<void>
  /** 暂停 / 继续目标（实现在 plan-goal.ts 的 pauseGoalMode / resumeGoalMode） */
  readonly pauseGoal: () => Promise<void>
  readonly resumeGoal: () => Promise<void>
  /** pending：有一次续跑已经决定、还没开出来 —— 此刻会话不能报 idle（实现在 goal-host.ts） */
  readonly goalContinuationPending: () => boolean
  /** 人按了停止：必须在 abort 之前调，被中断那一轮自己的 agent_end 才不会再排一次续跑 */
  readonly stopGoalContinuation: () => void
  /** 这两档此刻能不能用（现读 agent 设置；UI 据此隐藏选择器） */
  readonly planAvailable: () => boolean
  readonly goalAvailable: () => boolean
  readonly livePlanMode: () => boolean
  readonly liveGoal: () => string | null
  readonly liveGoalSnapshot: () => import('@poietica/engine').SessionGoalSnapshot | null
  /**
   * 历史投影的一页。`openTurnShown` = 开着的那一轮会由 `OpenTurnScreen` 换上实时版本：
   * 这时历史投影不要再把「最新一轮」标成 running —— omp 还没写进这句话时，最新一轮是上一轮，标了就错。
   */
  readonly page: (
    agentId: string,
    beforeTurnId: string | null,
    options: { readonly openTurnShown: boolean },
  ) => Promise<TranscriptPage>
  readonly now: () => number
  /** 此刻的斜杠命令表（omp 现算，GUI 拦掉的已剔除；实现在 slash-commands.ts） */
  readonly commands: () => Promise<readonly SlashCommand[]>
  /** 这句输入点名的命令（名字 + 来源）；不认识或 GUI 拦掉的是 null */
  readonly resolveCommand: (
    text: string,
  ) => Promise<{ readonly name: string; readonly source: SlashCommand['source'] } | null>
  /** 跑一条内置命令（omp 的 executeAcpBuiltinSlashCommand） */
  readonly runBuiltinCommand: (text: string, hooks: BuiltinCommandHooks) => ReturnType<typeof runBuiltinCommand>
  /** 累加器按会话文件重新落座：命令改过文件（压缩、重试）之后，下一轮的号要与历史投影对得上 */
  readonly reseat: () => void
  /** 停一个子代理（omp RPC cancel_subagent 同一条路，实现在 subagent-channels.ts）；false = 它不在运行 */
  readonly cancelSubagent: (agentId: string) => Promise<boolean>
  /** 给运行中的子代理插一句话（omp RPC steer_subagent）；不在运行时抛 engine.subagent_not_running */
  readonly steerSubagent: (agentId: string, text: string) => Promise<void>
  /** 停一个后台作业（omp 的 AsyncJobManager.cancel）；false = 已结束或不认识 */
  readonly cancelBackgroundTask: (taskId: string) => Promise<boolean>
  /** 侧边提问（omp 的 /btw，实现在 side-questions.ts）；它的事件经 `emitSide` 发出 */
  readonly side: Pick<SideQuestions, 'busy' | 'ask' | 'cancel' | 'topics' | 'close'>
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
  readonly input: SubmitInput
  /** 这一句带的图（审查 R-19-1）：被 message_start 认领、画成插话帧时一起上屏。号在入队时铸好 */
  readonly images: readonly ImageAttachmentInput[]
  /** 这一句带的普通文件：认领时与图一起挂到插话帧上，气泡才画得出那几枚记号 */
  readonly files: readonly FileAttachmentInput[]
}

/** 这一句带的普通文件 → 时间线附件条目。名字与投递正文里那一行同一份，重开之后读回来的也是它 */
function fileInputsOf(files: SubmitInput['files']): FileAttachmentInput[] {
  if (files.length === 0) return []
  const batch = createId()
  return files.map((file, index) => ({ attachmentId: `${batch}#f${String(index)}`, name: file.name }))
}

/**
 * 读好的图 → 时间线附件条目。号跨消息唯一，`#序号` 只为读日志时一眼看出是第几张。
 * 条目只带内容寻址的地址：像素已经交给 omp（prompt），不再随时间线复制一份 data URL。
 */
function imageInputsOf(images: readonly LoadedImage[], mediaRef: MediaRef): ImageAttachmentInput[] {
  const batch = createId()
  return images.map((image, index) => ({
    attachmentId: `${batch}#${String(index)}`,
    mediaType: image.mime,
    sha256: mediaRef({ data: image.base64 }),
  }))
}

/**
 * 状态机只有三格（idle → running ⇄ awaiting），只在 setState 里改；队列账本自己记 —— omp 的
 * getQueuedMessages() 只回文本数组、没有 id，而端口要求队列项有稳定 id。
 */
export class OmpSession implements EngineSession {
  readonly sessionId: string
  readonly sessionFile: string
  /* 监听者异常带上下文记一条 error：裸文本看不出是哪条会话、哪种事件 */
  private readonly events: Emitter<EngineSessionEvent>
  private readonly ledger: QueueEntry[] = []
  /** 已被 omp 从队列里取走、还没等到 message_start 的项（只在这一次运行内有效） */
  private readonly consumed: QueueEntry[] = []
  /** 本轮自己的 prompt：第一条对上的 message_start 不是插话 */
  private ownPrompt: { readonly kind: 'user'; readonly wireText: string } | { readonly kind: 'skill' } | null = null
  private mutation: Promise<void> = Promise.resolve()
  private readonly modes: QueueSnapshot['modes'] = { steer: 'all', followUp: 'all' }
  private readonly subscriptions: { dispose(): void }[] = []
  /** 开着的那一轮在屏幕上已经是什么样：整页重取时这一轮用它，不用历史投影的版本（见 OpenTurnScreen） */
  private readonly openTurn = new OpenTurnScreen()
  /** 题组 ↔ ask 调用号：askDialog 不带号，号只在工具事件里（Q1-E） */
  private readonly askCalls = new AskCallTracker()
  private stateValue: SessionState = 'idle'
  /**
   * `agent_end` 到达时还有待答交互：记下结局，等交互全部答完再收成 idle。不记的话那一轮永远收不了尾
   * —— 等用户答完，`onPendingCountChanged` 把它切回 running，然后再也没有人把它变成 idle。
   */
  private endedWithPending: { readonly error: { code: string; message: string } | null } | null = null
  private postureValue: Posture
  private modelRef: ModelRef | null
  private thinkingValue: string | null
  private disposed = false
  /** 还没有订阅者时收到的会话名先存着（见 subscribe 的补发） */
  private seededTitle: { readonly title: string; readonly source: 'auto' | 'user' } | null = null
  /**
   * 正在执行的目标改动数。大于 0 时 omp 的 goal_updated 不各自重报控件：一次「换暂停目标的正文」
   * 在 omp 里是 resume → replace → pause 三步，逐条重报会让屏幕闪一下「进行中」。
   */
  private goalBatch = 0
  /**
   * 目标续跑走到哪一步：`none ──settleIdle──▶ held ──reserve──▶ reserved ──message_start──▶ running`。
   * held / reserved 期间状态留在 running：两轮续跑之间不报 idle —— 否则输入框的停止键会闪、
   * Core 的 turnSettled 每一轮各发一次、会话池会把它当空闲会话回收。
   */
  private goalRun: 'none' | 'held' | 'reserved' | 'running' = 'none'
  /** held 期间留着的上一轮错误：最后真收成 idle 时原样报出（Core 据此判 failed） */
  private heldError: { code: string; message: string } | null = null
  /**
   * 正在跑的斜杠命令。非 null 时这一轮是「命令轮」：收口之后整页重取（命令改的是会话文件，增量里猜不出它改了什么），
   * 停止键要连同命令自己的 AbortSignal 一起拉。
   */
  /** 在跑的那条命令：中止信号，以及它有没有在时间线上开一格「正在压缩 / 正在生成交接文档」 */
  private commandRun: { readonly abort: AbortController; readonly compacting: boolean } | null = null

  constructor(
    private readonly o: OmpSessionHost,
    ids: { readonly sessionId: string; readonly sessionFile: string },
  ) {
    this.sessionId = ids.sessionId
    this.sessionFile = ids.sessionFile
    this.events = new Emitter<EngineSessionEvent>({
      onListenerError: (error) =>
        o.logger.error('session listener threw', {
          sessionId: ids.sessionId,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        }),
    })
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

  /* 侧边一问在答也算忙（端口注释）：会话池回收会把它当场停掉；只问主对话忙不忙的读 state() */
  isBusy(): boolean {
    return this.stateValue !== 'idle' || this.o.side.busy
  }

  subscribe(listener: (event: EngineSessionEvent) => void): { dispose(): void } {
    const subscription = this.events.event(listener)
    /* 监听者异常带上下文记一条 error —— Core 的 stderr 会被 Host 收进 core.log，裸文本看不出是哪条会话 */
    if (this.seededTitle !== null) {
      const seeded = this.seededTitle
      this.seededTitle = null
      this.emit({ type: 'sessionTitle', ...seeded, sessionFile: this.sessionFile })
    }
    return subscription
  }

  private emit(event: EngineSessionEvent): void {
    if (this.disposed) return
    this.events.fire(event)
  }

  private setState(next: SessionState, error: { code: string; message: string } | null = null): void {
    if (this.stateValue === next && error === null) return
    this.stateValue = next
    /* 转为 idle：等认领的项在这里作废，否则会在下一轮里认领出重复气泡 */
    if (next === 'idle') {
      this.consumed.length = 0
      this.ownPrompt = null
    }
    this.emit({ type: 'state', state: next, error })
  }

  private timeline(ops: readonly TranscriptOperation[]): void {
    if (ops.length === 0) return
    if (!this.openTurn.observe(ops)) {
      this.o.logger.warn('open turn screen diverged; pages fall back to history projection', { ops: ops.length })
    }
    this.emit({ type: 'timeline', agentId: 'main', ops })
  }

  /** broker 变化：待答交互数决定 running 与 awaiting 的来回切 */
  onPendingCountChanged(pendingCount: number): void {
    /* 必须**先于**切回 running 那一支 —— 切回 running 之后就再也没人把它变回 idle 了 */
    if (pendingCount === 0 && this.endedWithPending !== null) {
      const { error } = this.endedWithPending
      this.endedWithPending = null
      this.settleIdle(error)
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
    /* 图片先读一次：同一份像素既画 attachment.upsert 又交给 omp prompt，不再同步读两遍 */
    this.endedWithPending = null
    this.setState('running')
    /*
     * 自动总结标题**不在这里**（omp 知识 #17）：omp 自己在首条回复开始流式时起名（`config.autoTitle`，
     * 由 session-factory 开会话时打开），起好经 `onSessionNameChanged` 报回来。宿主要做的只有一条：
     * 用户定过名的线程把 `spec.autoTitle` 关掉 —— 那是对 omp 的输入，不是这里代它发一次请求。
     */
    // 不 await：一轮会挂在交互上，submit 必须立即返回
    void this.runTurn(input)
  }

  private async runTurn(input: SubmitInput): Promise<void> {
    try {
      const images = input.images.length === 0 ? [] : await this.o.loadImages(input.images)
      /* 号只签一次：attachment.upsert 与轮头引用同一批（投影按号查附件），两者由 userTurn 一起发 */
      this.timeline(
        this.o.projector.userTurn({
          text: input.text,
          skills: input.skills,
          ...(images.length === 0 ? {} : { images: imageInputsOf(images, this.o.mediaRef) }),
          ...(input.files.length === 0 ? {} : { files: fileInputsOf(input.files) }),
        }),
      )
      const skillMessage = input.skills.length === 0 ? null : await this.skillTextFor(input)
      this.ownPrompt = skillMessage === null ? { kind: 'user', wireText: wireTextOf(input) } : { kind: 'skill' }
      const delivered = await this.o.promptWithImages(input, images, skillMessage)
      if (!delivered) {
        // omp 没有把这条输入交给模型（例如被扩展拦截）：以 completed 收掉这个空轮
        this.closeTurnAfterRun('completed', null, null)
      }
    } catch (error) {
      const mapped = toEngineError(error)
      this.closeTurnAfterRun('failed', mapped.message, { code: mapped.code, message: mapped.message })
    }
  }

  /** `runTurn` 里的收尾：投影异常只记日志再吞掉 —— `runTurn` 是 `void` 调用的，抛出去就是未处理的 rejection */
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
   * 一轮的收口：① 轮头已关 → ② 累加器已复位 → ③ 状态回到 idle。
   * 顺序不能换：idle 一发出，订阅方就可能在同一个调用栈里投递下一条排队消息。
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
      this.settleIdle(error)
      this.closeCommandRun()
    }
  }

  /**
   * 命令轮收口：累加器按文件重新落座，再整页重取。命令那一句没有写进会话文件（omp 不记命令原文），
   * 重取之后屏幕上留下的就是文件里的事实（压缩摘要、重跑出的回答……），与重开会话看到的一致。
   */
  private closeCommandRun(): void {
    if (this.commandRun === null) return
    /* 开过的那一格不必单独关：整页重取会把它换成会话文件里的那一行（失败、取消时就是没有这一行）；这里只把投影里的门复位 */
    if (this.commandRun.compacting) this.o.projector.compactionEnd(null)
    this.commandRun = null
    try {
      this.o.reseat()
    } catch (error) {
      this.o.logger.warn('reseat after command failed', { error: describeError(error) })
    }
    this.emit({ type: 'timelineReset', agentId: 'main' })
    /* /compact、/shake、/handoff 这类本地命令不走 agent_end，用量那一格要在这里补报，否则仪表停在压缩前的读数 */
    try {
      this.reportContextUsage()
    } catch (error) {
      this.o.logger.warn('context usage after command failed', { error: describeError(error) })
    }
  }

  /** 一次运行收尾之后落到哪一格：还挂着交互 → 等答完再来；控制器已决定续跑 → held；否则 → idle */
  private settleIdle(error: { code: string; message: string } | null): void {
    if (this.o.broker.pendingCount() > 0) {
      this.endedWithPending = { error }
      return
    }
    if (!this.disposed && this.o.goalContinuationPending()) {
      this.goalRun = 'held'
      this.heldError = error
      if (this.stateValue !== 'running') this.setState('running')
      return
    }
    this.goalRun = 'none'
    this.heldError = null
    this.setState('idle', error)
  }

  /**
   * goal-host 在把续跑交给 omp 之前**同步**调它。只在「会话空着」或「正 held 着等这一轮」时答应，
   * Poietica 自己有一轮正在起步（状态已切 running、或时间线开着一轮）就让位，控制器会作废这次续跑。
   */
  reserveGoalContinuation(): boolean {
    if (this.disposed || this.o.projector.isTurnOpen) return false
    const free = this.goalRun === 'held' || (this.goalRun === 'none' && this.stateValue === 'idle')
    if (!free) return false
    this.goalRun = 'reserved'
    this.endedWithPending = null
    if (this.stateValue !== 'running') this.setState('running')
    return true
  }

  /** omp 开始跑续跑那一轮（message_start 认出续跑消息）：时间线开一轮 */
  startGoalContinuationTurn(): void {
    if (this.o.projector.isTurnOpen) return
    this.goalRun = 'running'
    if (this.stateValue !== 'running') this.setState('running')
    this.timeline(this.o.projector.goalContinuationTurn())
  }

  /** 预留的续跑没开出来：还没开轮 → 按 settleIdle 收；已经开了轮又抛错 → 这一轮按 failed 收 */
  releaseGoalContinuation(error: unknown): void {
    if (this.goalRun === 'reserved') {
      if (error !== null) this.o.logger.warn('goal continuation failed', { error: describeError(error) })
      this.settleIdle(null)
      return
    }
    if (this.goalRun === 'running' && error !== null && this.o.projector.isTurnOpen) {
      const mapped = toEngineError(error)
      this.closeTurnAfterRun('failed', mapped.message, { code: mapped.code, message: mapped.message })
    }
  }

  /** 控制器放弃了一次待开的续跑（等待期间某道闸关掉了）：还 held、没别轮开着、也没有新的待开续跑时才收成 idle */
  goalContinuationDropped(): void {
    if (this.goalRun !== 'held' || this.o.projector.isTurnOpen || this.o.goalContinuationPending()) return
    const error = this.heldError
    this.goalRun = 'none'
    this.heldError = null
    this.setState('idle', error)
  }

  /** 人按了「继续」之后控制器可能已经排好一次续跑：立刻切成 running，别让 UI 以为还空着 */
  private holdForGoalContinuation(): void {
    if (this.disposed || this.stateValue !== 'idle' || !this.o.goalContinuationPending()) return
    this.goalRun = 'held'
    this.heldError = null
    this.setState('running')
  }

  /** 展开失败**必须让这一轮收成 failed**：乐观帧已经上屏，吞掉异常就是屏幕上那一轮永远转下去 */
  private async skillTextFor(input: SubmitInput, images?: readonly LoadedImage[]): Promise<SkillPromptMessage | null> {
    return await this.o.skillMessage(input, images)
  }

  /** 串行入队：技能展开是异步的，先发出的那条必须先进账本，否则账本顺序与 omp 队列顺序会错位 */
  private enqueue(input: SubmitInput, deliverAs: 'steer' | 'followUp'): Promise<void> {
    return this.serial(async () => {
      this.assertLive()
      /* 图在这里读一次：同一份像素既交给 omp，也留在账本里等认领时画到插话帧上（审查 R-19-1） */
      const images = input.images.length === 0 ? [] : await this.o.loadImages(input.images)
      this.assertLive()
      const loaded = images.length === 0 ? undefined : images
      const skillMessage = input.skills.length === 0 ? null : await this.skillTextFor(input, loaded)
      const { wireText } = await this.o.steer(input, deliverAs, skillMessage, loaded)
      this.ledger.push({
        id: createId(),
        text: input.text,
        wireText,
        skill: skillMessage !== null,
        deliverAs,
        createdAt: this.o.now(),
        input,
        images: imageInputsOf(images, this.o.mediaRef),
        files: fileInputsOf(input.files),
      })
      this.emitQueue()
    })
  }

  /** 队列变更的串行链：一次失败不阻断下一次 */
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
   * 与 omp 的队列对账：按账本顺序做多重集匹配（同样的文本可以出现多次）。账本里有、omp 里已没有的
   * 项说明已经投递，搬进 `consumed` 等 message_start 认领 —— 直接丢弃会让那一句永远画不出来。
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
        this.settleQueued(entry, 'delivered')
      }
    }
    this.ledger.length = 0
    this.ledger.push(...keep)
    this.emitQueue()
  }

  /**
   * 排队项的结局交回调用方（审查 R-20-1）：conversation 靠它把提交行收口 —— 不报，那一行就一直停在
   * `queued`，下次 Core 启动被当成「没送到」改成 failed，旧对话里凭空冒出「提交未完成」。
   */
  private settleQueued(entry: QueueEntry, outcome: QueueOutcome): void {
    const ref = entry.input.ref
    if (ref === undefined) return
    this.emit({ type: 'queueSettled', ref, outcome })
  }

  async cancel(): Promise<void> {
    this.assertLive()
    /* 先停续跑、再 abort：被中断那一轮自己的 agent_end 也会过控制器，不先停它就会再排一次续跑 */
    this.o.stopGoalContinuation()
    this.endedWithPending = null
    /* 命令自己的活（压缩、交接摘要）不一定挂在 agent 的 abort 上：把交给命令的那根信号一起拉掉 */
    this.commandRun?.abort.abort()
    this.o.broker.cancelAll()
    await this.o.abort()
    this.goalRun = 'none'
    this.heldError = null
    if (this.stateValue !== 'idle') this.setState('idle')
  }

  queue(): QueueSnapshot {
    /* 逐字段拷：账本项里还带着图片的 data URL，整份展开会让每一次队列通知都把像素再送一遍 */
    return {
      items: this.ledger.map((e) => ({
        id: e.id,
        text: e.text,
        deliverAs: e.deliverAs,
        createdAt: e.createdAt,
        ...(e.input.ref === undefined ? {} : { ref: e.input.ref }),
      })),
      modes: { ...this.modes },
    }
  }

  withdraw(queueItemId: string): void {
    this.withdrawEntry(queueItemId, true)
  }

  /**
   * `settle` 为 false 只给换层用：`moveQueued` 撤下来马上用同一份输入（同一个 ref）重新入队，
   * 这时报 `withdrawn` 会让调用方把还活着的那一句收掉。
   */
  private withdrawEntry(queueItemId: string, settle: boolean): QueueEntry {
    this.assertLive()
    const at = this.ledger.findIndex((entry) => entry.id === queueItemId)
    if (at < 0) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    const entry = this.ledger.splice(at, 1)[0]!
    const removed = this.o.removeQueued(entry.wireText, entry.deliverAs)
    if (removed) {
      if (settle) this.settleQueued(entry, 'withdrawn')
    } else {
      // omp 已经取走：它即将（或已经）上屏，留在 consumed 里等 message_start 认领；换层也一样是送达了
      this.consumed.push(entry)
      this.settleQueued(entry, 'delivered')
    }
    this.emitQueue()
    if (!removed) throw new AppError(EngineErrorCode.queueItemConsumed, '这条消息已经交给 agent，撤不回来了')
    return entry
  }

  async moveQueued(queueItemId: string, deliverAs: 'steer' | 'followUp'): Promise<void> {
    this.assertLive()
    const entry = this.ledger.find((e) => e.id === queueItemId)
    if (entry === undefined) throw new AppError(SystemErrorCode.notFound, '队列里没有这一项')
    if (entry.deliverAs === deliverAs) return
    this.withdrawEntry(queueItemId, false)
    await this.enqueue(entry.input, deliverAs)
  }

  setQueueModes(modes: Partial<QueueSnapshot['modes']>): void {
    Object.assign(this.modes, modes)
    if (modes.steer !== undefined) this.o.setQueueMode('steer', modes.steer)
    if (modes.followUp !== undefined) this.o.setQueueMode('followUp', modes.followUp)
    this.emitQueue()
  }

  controls(): Controls {
    /**
     * 现读会话此刻的真相，读不到才退回这一层记下的那一份：会话刚建好、SDK 还没选出模型时
     * `session.model` 是 undefined，那一份就是唯一已知值；SDK 自己挑了一条时只有 liveModel 知道。
     */
    const current = this.o.liveModel() ?? this.modelRef
    /**
     * 候选是**这一家 agent 的全部可用模型**；先前只造当前这一条、label 写成 provider/id，屏幕上就看不到
     * 模型名字、也换不了别条（真实故障：用户报「显示的是模型 id 而不是模型名称」）。当前那一条不在候选里时
     * 补一条进去（会话自己挑的模型可能不在白名单里）。
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
      /* 计划与目标都现读会话此刻的真相：模型自己收尾、或人在别处改了模式时，只有会话知道 */
      planMode: this.o.livePlanMode(),
      goal: this.o.liveGoal(),
      goalSnapshot: this.o.liveGoalSnapshot(),
      available: { plan: this.o.planAvailable(), goal: this.o.goalAvailable() },
      context: this.o.contextUsage(),
    }
  }

  /**
   * 梯子与选中值都要在没有会话真相时也答得出来：会话刚建好时两个读数都是空的，照原样报出去屏幕上就是
   * 「模型卡片里没有思考强度，切换一次之后才长出来」（真实故障）。候选退回这条模型静态的梯子，选中值依次
   * 退回这一层记下的那一份、模型声明的默认档；任何一条来源都没有就如实交空表，不编四档。
   */
  private thinkingControls(model: ModelRef | null): Controls['thinking'] {
    const live = this.o.thinkingChoices()
    const choices = live.length > 0 ? live : this.o.thinkingFallback(model)
    const current = this.o.liveThinking() ?? this.thinkingValue ?? this.o.defaultThinking(model)
    return {
      current,
      /* label 就是档位原文：卡的版式自己把首字母大写，而档位名是 agent 报的原文，产品不翻译它 */
      choices: choices.map((level) => ({ id: level, label: level })),
    }
  }

  private emitControls(): void {
    this.emit({ type: 'controls', controls: this.controls() })
  }

  /** omp 自己改的模型 / 档位 / 目标也要让 UI 知道；目标改动进行中先不报（见 goalBatch） */
  controlsChanged(): void {
    if (this.goalBatch > 0) return
    this.emitControls()
  }

  /**
   * **真的把它交给会话**（omp 的 setModel），不是只改本地那一格：只写 `this.modelRef` 的话屏幕上报的与
   * 实际在跑的就是两条（真实故障「输入框显示的模型与我用的模型不一样」）。本地那一份仍记，因为 omp 的
   * `session.model` 在切换落地前可能还是旧值，`controls()` 需要它兜底。
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
    /* 关掉计划模式时先把还在等的计划卡片按 dismiss 兑现：卡片留着等人答复而模式已退出，那一轮就永远收不了尾 */
    if (!enabled) {
      for (const interaction of this.o.broker.pending()) {
        if (interaction.kind === 'plan') this.o.broker.answer(interaction.id, { kind: 'dismiss' })
      }
    }
    await this.o.applyPlanMode(enabled)
    this.emitControls()
  }

  async setGoal(goal: string | null): Promise<void> {
    await this.changeGoal(() => this.o.applyGoal(goal))
  }

  async pauseGoal(): Promise<void> {
    await this.changeGoal(() => this.o.pauseGoal())
  }

  async resumeGoal(): Promise<void> {
    await this.changeGoal(() => this.o.resumeGoal())
    // 继续 = 接着推进：空闲时控制器已经排好一次续跑
    this.holdForGoalContinuation()
  }

  /** 目标改动的统一外壳：期间压住逐条重报，收尾只报一次真相 */
  private async changeGoal(change: () => Promise<void>): Promise<void> {
    this.assertLive()
    this.goalBatch += 1
    try {
      await change()
    } finally {
      this.goalBatch -= 1
      this.emitControls()
    }
  }

  /** omp 报命令表变了（事件泵外的那条订阅）：`emit` 是 private，这里留的出口 */
  commandsChanged(): void {
    this.emit({ type: 'commandsChanged' })
  }

  async commands(): Promise<readonly SlashCommand[]> {
    this.assertLive()
    return await this.o.commands()
  }

  /**
   * 斜杠命令（端口语义见 EngineSession.runCommand）。路由与 omp 的宿主同一个次序：内置命令走
   * executeAcpBuiltinSlashCommand；其余（扩展 / 自定义 / 文件 / MCP 提示词命令）原样交给 prompt，由 omp 就地展开。
   * 命令先开一轮把原句画上屏：`/retry` 这类命令排出的那一轮 agent 要有地方落；本地命令收口时这一轮随整页重取消失。
   * `/compact`、`/handoff` 例外：不画原句，改开一格压缩行（「正在压缩上下文…」/「正在生成交接文档…」）——
   * omp 手动跑它们时不发 auto_compaction_start，不开这一格，几十秒里屏幕上只有一句 `/compact`；收口整页重取后，
   * 这一格落成会话文件里那一行「上下文已压缩 …」，位置不跳。
   */
  async runCommand(text: string): Promise<void> {
    this.assertLive()
    if (this.stateValue !== 'idle') throw new AppError(EngineErrorCode.busy, 'agent 正忙')
    const line = text.trim()
    const command = await this.o.resolveCommand(line)
    if (command === null) {
      throw new AppError(EngineErrorCode.commandUnknown, `没有这条命令：${line.split(/\s+/)[0] ?? line}`)
    }
    /* 查表要等一拍：这一拍里可能已经有一轮开出来了 */
    if (this.stateValue !== 'idle') throw new AppError(EngineErrorCode.busy, 'agent 正忙')
    this.endedWithPending = null
    this.setState('running')
    const abort = new AbortController()
    const compaction = compactionActionOf(command)
    this.commandRun = { abort, compacting: compaction !== null }
    this.timeline(
      compaction === null
        ? this.o.projector.userTurn({ text: line, skills: [] })
        : this.o.projector.compactionStart({ reason: 'manual', action: compaction }),
    )
    // 不 await：压缩之类的命令要跑很久，调用方与 submit 一样只等「开始了」
    void this.driveCommand(line, command.source, abort.signal)
  }

  private async driveCommand(line: string, source: SlashCommand['source'], signal: AbortSignal): Promise<void> {
    try {
      let prompt = line
      if (source === 'builtin') {
        const result = await this.o.runBuiltinCommand(line, {
          signal,
          /* 已在别处体现的结果（压缩行、标题、模型胶囊）不推；认得的句子换成中文并定色调（command-output.ts） */
          output: (chunk) => {
            const said = commandOutputOf(chunk)
            if (said !== null) this.emit({ type: 'commandOutput', text: said.text, tone: said.tone })
          },
          configChanged: () => this.controlsChanged(),
          commandsChanged: () => this.commandsChanged(),
        })
        if (result.kind === 'local') {
          this.closeTurnAfterRun('completed', null, null)
          return
        }
        /* 命令自己排了一轮（`/retry`）：那一轮的 agent_end 收口 */
        if (result.kind === 'turn') return
        if (result.kind === 'prompt') prompt = result.text
      }
      const input: SubmitInput = { text: prompt, images: [], files: [], skills: [], deliverAs: 'turn' }
      this.ownPrompt = { kind: 'user', wireText: wireTextOf(input) }
      const delivered = await this.o.promptWithImages(input, [], null)
      /* omp 在 prompt 里就地办完（扩展命令、自定义 TS 命令）：没有 agent_end，这里收口 */
      if (!delivered) this.closeTurnAfterRun('completed', null, null)
    } catch (error) {
      const mapped = toEngineError(error)
      /* 命令轮收口会整页重取，挂在这一轮上的报错帧也会随之消失：失败原文改走命令输出那一块 */
      const said = commandErrorOf(mapped.message)
      this.emit({ type: 'commandOutput', text: said.text, tone: said.tone })
      this.closeTurnAfterRun('failed', mapped.message, { code: mapped.code, message: mapped.message })
    }
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
    /* 与历史投影同一刻取：o.page 的投影在调用时就同步算完，等它的这一拍里可能又发出了增量 */
    const view = agentId === 'main' ? this.openTurn.view() : null
    const page = await this.o.page(agentId, beforeTurnId, { openTurnShown: view !== null })
    return overlayOpenTurn(page, view, beforeTurnId === null)
  }

  /** 转发交互事件、把卡片 upsert 上屏、按待答数调整状态；session-factory 在 omp 会话建好后调用一次 */
  attachBroker(): { dispose(): void } {
    return this.o.broker.onChange((change) => {
      if (change.type === 'requested') {
        this.emit({ type: 'interactionRequested', interaction: change.interaction })
        const call = this.askCalls.requested(change.interaction)
        this.interactionOp(withToolCall(interactionCardOf(change.interaction), call))
      } else {
        this.emit({ type: 'interactionResolved', interactionId: change.interaction.id })
        const call = this.askCalls.resolved(change.interaction.id)
        this.interactionOp(withToolCall(interactionCardOf(change.interaction, { answer: change.answer }), call))
      }
      this.onPendingCountChanged(this.o.broker.pendingCount())
    })
  }

  /** 插话落地：本轮自己的 prompt 不画（userTurn 已画），对得上队列项才画成一句人话 */
  onUserMessageStart(wireText: string): void {
    const own = this.ownPrompt
    if (own !== null && own.kind === 'user' && own.wireText === wireText) {
      this.ownPrompt = null
      return
    }
    const entry = this.takeConsumed((e) => !e.skill && e.wireText === wireText)
    if (entry !== null) this.timeline(this.o.projector.steeredFrame(entry.text, entry.images, entry.files))
  }

  /** 技能消息没有可靠的正文可对，按 FIFO 认领最早的技能项 */
  onSkillMessageStart(): void {
    if (this.ownPrompt?.kind === 'skill') {
      this.ownPrompt = null
      return
    }
    const entry = this.takeConsumed((e) => e.skill)
    if (entry !== null) this.timeline(this.o.projector.steeredFrame(entry.text, entry.images, entry.files))
  }

  /** 先在 consumed 里找（queue_update 先到），再在 ledger 里找（message_start 先到） */
  private takeConsumed(match: (entry: QueueEntry) => boolean): QueueEntry | null {
    const c = this.consumed.findIndex(match)
    if (c >= 0) return this.consumed.splice(c, 1)[0] ?? null
    const l = this.ledger.findIndex(match)
    if (l < 0) return null
    const [entry] = this.ledger.splice(l, 1)
    if (entry !== undefined) this.settleQueued(entry, 'delivered')
    this.emitQueue()
    return entry ?? null
  }

  /**
   * 一次工具调用开始 / 结束（事件泵转来）。只认 ask：题组先到、号后到时，在这里把号补进那张待答卡 ——
   * 收口那张卡同样带着号，答过的题组才锚得到发起它的那次调用（Q1-E）。
   */
  onToolStart(toolCallId: string, toolName: string): void {
    if (toolName !== ASK_TOOL) return
    const asked = this.askCalls.started(toolCallId)
    if (asked !== null) this.interactionOp(withToolCall(interactionCardOf(asked), toolCallId))
  }

  onToolEnd(toolCallId: string, toolName: string): void {
    if (toolName === ASK_TOOL) this.askCalls.ended(toolCallId)
  }

  /** 交互上屏：requested 时 pending，resolved 时终态；卡片形状归 `interactionCardOf`，不归 broker（它不认识 transcript） */
  interactionOp(interaction: TranscriptInteraction): void {
    this.emit({ type: 'timeline', agentId: 'main', ops: [{ op: 'interaction.upsert', interaction }] })
  }

  requestTimeline(ops: readonly TranscriptOperation[]): void {
    this.timeline(ops)
  }

  /**
   * 子代理通道的增量：**不过** `openTurn` —— 那块屏只认主对话的开着那一轮，子代理的帧喂进去会让它判成分叉、
   * 主对话的页退回历史投影。子代理自己的开轮屏由 subagent-channels 各自持有。
   */
  emitAgentTimeline(agentId: string, ops: readonly TranscriptOperation[]): void {
    if (ops.length === 0 || this.disposed) return
    this.emit({ type: 'timeline', agentId, ops })
  }

  async cancelSubagent(agentId: string): Promise<boolean> {
    this.assertLive()
    return this.o.cancelSubagent(agentId)
  }

  async steerSubagent(agentId: string, text: string): Promise<void> {
    this.assertLive()
    if (text.trim() === '') throw new AppError(SystemErrorCode.invalidParams, '引导的话不能为空')
    await this.o.steerSubagent(agentId, text)
  }

  async cancelBackgroundTask(taskId: string): Promise<boolean> {
    this.assertLive()
    return this.o.cancelBackgroundTask(taskId)
  }

  // ── 侧边提问（omp 的 /btw，omp 知识 #21）：不碰时间线、不改 state ─────────────
  async askSide(question: string, topicId: string | null): Promise<SideTopic> {
    this.assertLive()
    return await this.o.side.ask(question, topicId)
  }

  cancelSide(topicId: string | null): boolean {
    if (this.disposed) return false
    return this.o.side.cancel(topicId)
  }

  async sideTopics(): Promise<readonly SideTopic[]> {
    this.assertLive()
    return await this.o.side.topics()
  }

  /** side-questions.ts 的出口：`emit` 是 private */
  emitSide(event: SideEvent): void {
    this.emit(event)
  }

  /** omp 的会话名变了（自动总结或用户定名，omp 知识 #17）：`emit` 是 private，这里留的出口 */
  emitSessionTitle(title: string, source: 'auto' | 'user'): void {
    if (!this.events.hasListeners) {
      this.seededTitle = { title, source }
      return
    }
    this.emit({ type: 'sessionTitle', title, source, sessionFile: this.sessionFile })
  }

  async rename(title: string): Promise<void> {
    this.assertLive()
    if (!(await this.o.setSessionName(title))) {
      throw new AppError(SystemErrorCode.invalidParams, '会话名不能为空')
    }
  }

  /**
   * omp 丢掉了一句用户输入（omp 知识 #8）。它只交回原文：账本 / 待认领里对得上的那一项一并摘掉并报 `dropped`，
   * 否则那一项留在队列里像是还会送达，提交行也收不了口（审查 R-20-1）。
   */
  emitPromptDropped(text: string): void {
    const match = (entry: QueueEntry): boolean => entry.text === text || entry.wireText === text
    const c = this.consumed.findIndex(match)
    if (c >= 0) {
      this.settleQueued(this.consumed.splice(c, 1)[0]!, 'dropped')
    } else {
      const l = this.ledger.findIndex(match)
      if (l >= 0) {
        this.settleQueued(this.ledger.splice(l, 1)[0]!, 'dropped')
        this.emitQueue()
      }
    }
    this.emit({ type: 'promptDropped', text })
  }

  timelineReset(agentId: string): void {
    this.emit({ type: 'timelineReset', agentId })
  }

  /** 一轮结束（omp 的 agent_end）：结局由最后一条 assistant 消息决出 */
  finishTurn(): void {
    // 重复的 agent_end：轮已关、状态已空闲，再走一遍只会重复发 state 事件
    if (!this.o.projector.isTurnOpen && (this.stateValue === 'idle' || this.goalRun === 'held')) return
    let outcome: TurnOutcome
    try {
      outcome = outcomeOf(this.o.lastAssistant())
    } catch (error) {
      /** 读不到结局时按 completed 收：omp 自己已经正常结束了这一轮，标成 failed 会让定时任务记假失败、屏幕出现红轮 */
      this.o.logger.warn('turn outcome unavailable', { error: describeError(error) })
      outcome = { outcome: 'completed', message: null }
    }
    this.settleTurn(
      outcome.outcome,
      outcome.message,
      outcome.message === null ? null : { code: EngineErrorCode.upstream, message: outcome.message },
    )
  }

  emitUsageFrom(message: Parameters<typeof usageOf>[0]): void {
    const sample = usageOf(message, this.o.now())
    if (sample !== null) this.emit({ type: 'usage', usage: sample })
  }

  /**
   * **每条 assistant 消息落地**一次、**轮终**再一次：前者让数字跟着一轮里的每一步走，后者兜住
   * 「最后一条消息之后压缩、图片落地又改了上下文」。不接流式 delta —— token 不随 delta 落库。
   */
  reportContextUsage(): void {
    this.emit({ type: 'contextUsage', usage: this.o.contextUsage() })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    /* 在答的侧边一问先停：「已停止」那份快照要赶在关门之前发给订阅者，屏幕才不会停在「正在回答」 */
    this.o.side.cancel(null)
    this.disposed = true
    for (const subscription of this.subscriptions) subscription.dispose()
    this.o.broker.cancelAll()
    /* omp 的会话关掉之前把侧边话题收口的那一笔落盘（RpcBtwController.close 的约定）；它自己不抛 */
    await this.o.side.close()
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

/** omp 提问工具的名字（tools/ask.ts 的 `readonly name = "ask"`） */
const ASK_TOOL = 'ask'

function withToolCall(card: TranscriptInteraction, toolCallId: string | undefined): TranscriptInteraction {
  return toolCallId === undefined ? card : { ...card, toolCallId }
}
