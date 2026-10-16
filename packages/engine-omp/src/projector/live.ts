import { frameId, stepId, type TranscriptAttachment, type TranscriptOperation, turnId } from '@poietica/transcript'
import { assistantFrameId, interjectionFrameId } from './frame-ids'
import { GOAL_CONTINUATION_ORIGIN, type TurnOrigin } from './origin'

/** 一张图片附件：号由调用方铸（session 里的 createId），像素是内联 data URL */
export interface ImageAttachmentInput {
  readonly attachmentId: string
  readonly mediaType: string
  readonly dataUrl: string
  readonly name?: string
}

function attachmentOf(input: ImageAttachmentInput): TranscriptAttachment {
  return {
    attachmentId: input.attachmentId,
    mediaType: input.mediaType,
    source: { kind: 'url', url: input.dataUrl },
    ...(input.name === undefined ? {} : { name: input.name }),
  }
}

/**
 * 一份普通文件附件（输入框里那枚文件记号、元素拾取的报告）：没有像素，只有名字 —— 气泡上画成一枚记号。
 * 类型一律记成 octet-stream：会话文件里读不回真实类型，增量与重开两条路必须同形，这一格也只用来跟图片分开。
 */
export interface FileAttachmentInput {
  readonly attachmentId: string
  readonly name: string
}

export const FILE_MEDIA_TYPE = 'application/octet-stream'

export function fileAttachmentOf(input: FileAttachmentInput): TranscriptAttachment {
  return { attachmentId: input.attachmentId, mediaType: FILE_MEDIA_TYPE, name: input.name }
}

/** 工具帧降级时显示的正文（状态照实，正文换成这句；R-02） */
export const TOOL_FALLBACK_TEXT = '这一步的内容无法显示（详情已写入日志）'

interface Streaming {
  readonly id: string
  readonly kind: 'text' | 'thinking'
  /** omp 流式事件的 contentIndex（块在这条助手消息 content 里的下标）；号就由它派生 */
  readonly block: number
  readonly step: string
  /** 已经发出的字符数，也就是下一条 append 的 offset */
  readonly emitted: number
  /** 这一档相位从哪一刻开始；0 表示还没报过（冻结而不是每帧取新时刻，见 #advance 的注释） */
  readonly since: number
}

export interface LiveProjectorOptions {
  readonly now: () => number
  /** 时钟毫秒 → 时间戳字符串。默认 ISO */
  readonly iso?: (ms: number) => string
}

/**
 * omp 的会话事件 → transcript 的 ops。
 *
 * 它只维护指针：当前 turn/step 的号，以及每个流式帧已经发出了多少字。除此之外没有任何副作用：
 * 不发事件、不做 I/O、不写 console。append 认 offset，offset 大于已有长度就是缺口（TranscriptGapError），
 * 所以每个流式帧都要记住已发出的字数。
 */
export class LiveProjector {
  private turn = 0
  private step = 0
  /** 提示帧（notice）的流水号：只有增量这条路画提示帧，号与正文 / 插话不同名字空间 */
  private frame = 0
  /** 这一轮里第几条助手消息（message_start 计数，-1 = 还没来过）；正文 / 思维链帧的号由它 + contentIndex 派生 */
  private message = -1
  /** 这条助手消息里没带 contentIndex 的增量的兜底下标（老 omp / 测试替身） */
  private block = -1
  /** 这一轮里第几句插话 */
  private interjections = 0
  private turnOpen = false
  private stepOpen = false
  private streaming: Streaming | null = null
  /** 最近流过的那一帧（封口之后也留着）：同一块被打断后接着流时接回它，见 #stream */
  private lastStream: Streaming | null = null
  private readonly tools = new Map<string, string>()
  private readonly args = new Map<string, unknown>()
  private readonly intents = new Map<string, string>()
  /**
   * 这一轮开头那份轮头的 origin 与 prompt（审查 R-11）：turnEnd 要原样带回去。
   * turn.upsert 是整头替换（transcript 的 applyTurnUpsert），收尾时现造一份 `{ kind: 'user' }`
   * 会把开头的来源冲掉 —— 挂技能那一句的技能标签在这一轮跑完就消失，续跑那一轮会变回「人话」。
   */
  private origin: TurnOrigin = { kind: 'user' }
  /** undefined = 这一轮没有人话（目标续跑）：轮头不带 prompt */
  private prompt: string | undefined = undefined
  private promptId: string | undefined
  private startedAt = ''
  private attachmentIds: readonly string[] = []
  /** 这一轮开头那几张图的条目（审查 R-19-1）：这一轮还开着时历史分页要沿用同一批号，见 `openTurnAttachments`。 */
  private turnAttachments: readonly TranscriptAttachment[] = []

  /** 增量那条路上压缩格的流水号，与开着的那一格（还没关门） */
  private compactionSeq = 0
  private compactionOpen: string | null = null

  constructor(private readonly o: LiveProjectorOptions) {}

  private now(): string {
    const ms = this.o.now()
    return this.o.iso === undefined ? new Date(ms).toISOString() : this.o.iso(ms)
  }

  get turnOrdinal(): number {
    return this.turn
  }

  get isTurnOpen(): boolean {
    return this.turnOpen
  }

  /** 开着的这一轮由 userTurn 带进来的图片条目；没开着轮时为空 */
  get openTurnAttachments(): readonly TranscriptAttachment[] {
    return this.turnOpen ? this.turnAttachments : []
  }

  /**
   * 把累加器摆到屏幕上已有的位置：下一轮从 ordinal + 1 起号。
   * 只许在没开着轮时调：屏幕上的号是显示经过里的位置，增量这条路的号是它自己数的，两者不对齐就会盖掉已有的轮。
   */
  seat(ordinal: number): void {
    if (this.turnOpen) return
    this.turn = ordinal
  }

  /**
   * 一张图片的附件条目（每张图片先 attachmentOp 再 userTurn）。
   * 像素用 url 源直接给（data URL）：omp 读会话时已经把 blob 换成内联 base64，界面直接画得出来。
   */
  attachmentOp(input: ImageAttachmentInput): TranscriptOperation[] {
    return [{ op: 'attachment.upsert', attachment: attachmentOf(input) }]
  }

  /**
   * 一条用户消息：开一个新 turn。人话只在轮头（`turn.prompt`），**不再另发一条用户帧** —— 历史那条路从来不发它，
   * 而界面曾认「没有 origin 的用户帧」为来源不明，实时会话里前面几轮的分叉按钮全部失效（R-27）。
   * 带 `images` 时先发这几张图的条目、再开轮，轮头的 attachmentIds 就是这几张图的号（号由调用方铸）。
   */
  userTurn(input: {
    readonly text: string
    readonly attachmentIds?: readonly string[]
    readonly images?: readonly ImageAttachmentInput[]
    readonly files?: readonly FileAttachmentInput[]
    readonly promptId?: string
    readonly skills?: readonly string[]
  }): TranscriptOperation[] {
    const pictures = (input.images ?? []).map(attachmentOf)
    const attachments = [...pictures, ...(input.files ?? []).map(fileAttachmentOf)]
    const attachmentIds =
      attachments.length > 0 ? attachments.map((attachment) => attachment.attachmentId) : (input.attachmentIds ?? [])
    const skills = input.skills ?? []
    const origin: TurnOrigin =
      skills.length === 0
        ? { kind: 'user' }
        : {
            kind: 'user',
            payload: {
              kind: 'skill_activation',
              trigger: 'user-slash',
              skillActivations: skills.map((name) => ({ skillName: name })),
            },
          }
    const { ordinal, turn, at } = this.openTurn({
      origin,
      prompt: input.text,
      promptId: input.promptId,
      attachmentIds,
    })
    /* 只留图：历史分页按张数对号沿用的是图（`promptImagesOf`），文件在那条路上另起号。 */
    this.turnAttachments = pictures
    return [
      ...attachments.map((attachment): TranscriptOperation => ({ op: 'attachment.upsert', attachment })),
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn',
          turnId: turn,
          ordinal,
          state: 'running',
          origin,
          prompt: input.text,
          startedAt: at,
          ...(input.promptId === undefined ? {} : { triggerPromptId: input.promptId }),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        },
      },
      {
        op: 'step.upsert',
        turnId: turn,
        step: { kind: 'step', stepId: stepId(turn, 0), turnId: turn, ordinal: 0, state: 'running', startedAt: at },
      },
    ]
  }

  /**
   * 目标续跑开的一轮（审查 R-11）：omp 的控制器塞进来的是一条 display:false 的续跑提示，
   * 它不是人说的话 —— 轮头不带 prompt、不画用户气泡；段从 0 号起，第一帧就是模型自己的输出。
   */
  goalContinuationTurn(): TranscriptOperation[] {
    const { ordinal, turn, at } = this.openTurn({
      origin: GOAL_CONTINUATION_ORIGIN,
      prompt: undefined,
      promptId: undefined,
      attachmentIds: [],
    })
    return [
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn',
          turnId: turn,
          ordinal,
          state: 'running',
          origin: GOAL_CONTINUATION_ORIGIN,
          startedAt: at,
        },
      },
      {
        op: 'step.upsert',
        turnId: turn,
        step: { kind: 'step', stepId: stepId(turn, 0), turnId: turn, ordinal: 0, state: 'running', startedAt: at },
      },
    ]
  }

  /** 开一轮的累加器复位（userTurn 与 goalContinuationTurn 共用这一份，两处各写一遍就会漂移） */
  private openTurn(input: {
    readonly origin: TurnOrigin
    readonly prompt: string | undefined
    readonly promptId: string | undefined
    readonly attachmentIds: readonly string[]
  }): { readonly ordinal: number; readonly turn: string; readonly at: string } {
    const ordinal = this.turn + 1
    const at = this.now()
    this.turn = ordinal
    this.step = 0
    this.frame = 0
    this.message = -1
    this.block = -1
    this.interjections = 0
    this.lastStream = null
    this.turnOpen = true
    this.stepOpen = true
    this.streaming = null
    this.tools.clear()
    this.args.clear()
    this.intents.clear()
    this.origin = input.origin
    this.prompt = input.prompt
    this.promptId = input.promptId
    this.startedAt = at
    this.attachmentIds = input.attachmentIds
    this.turnAttachments = []
    return { ordinal, turn: turnId(ordinal), at }
  }

  /**
   * 一句插话：开着一轮时进当前 step 并封掉正在流的那一帧；没开着就退回 userTurn。
   * 插话带的图（审查 R-19-1）和开轮那一句同一个做法：先发条目，帧上挂号 —— 不挂号的话模型看得见、气泡上没有。
   */
  steeredFrame(
    text: string,
    images: readonly ImageAttachmentInput[] = [],
    files: readonly FileAttachmentInput[] = [],
  ): TranscriptOperation[] {
    if (!this.turnOpen) return this.userTurn({ text, images, files })
    const attachments = [...images.map(attachmentOf), ...files.map(fileAttachmentOf)]
    const attachmentIds = attachments.map((attachment) => attachment.attachmentId)
    this.streaming = null
    const turn = turnId(this.turn)
    const step = stepId(turn, this.step)
    this.interjections += 1
    const id = interjectionFrameId(turn, this.interjections)
    return [
      ...attachments.map((attachment): TranscriptOperation => ({ op: 'attachment.upsert', attachment })),
      {
        op: 'frame.upsert',
        turnId: turn,
        stepId: step,
        frame: {
          kind: 'text',
          role: 'user',
          frameId: id,
          text,
          origin: { kind: 'user' },
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        },
      },
    ]
  }

  /**
   * 一条助手消息开始（omp 的 `message_start`，role:assistant）：这一轮的助手消息序号进一，正在流的帧封口。
   * 历史那条路按同一个口径数（`turnOps` 里每条 role:assistant 的消息进一），两边对同一段话给出同一个号。
   */
  assistantMessageStart(): void {
    if (!this.turnOpen) return
    this.message += 1
    this.block = -1
    this.streaming = null
  }

  /** `contentIndex` = omp 流式事件里块在这条助手消息 content 里的下标；号由它派生（见 frame-ids.ts） */
  textDelta(delta: string, contentIndex?: number): TranscriptOperation[] {
    return this.stream('text', delta, contentIndex)
  }

  thinkingDelta(delta: string, contentIndex?: number): TranscriptOperation[] {
    return this.stream('thinking', delta, contentIndex)
  }

  private stream(kind: 'text' | 'thinking', delta: string, contentIndex: number | undefined): TranscriptOperation[] {
    if (!this.turnOpen) return []
    const turn = turnId(this.turn)
    const open = this.streaming
    if (open !== null && open.kind === kind && (contentIndex === undefined || open.block === contentIndex)) {
      return [appendOp(turn, open.step, open.id, open.emitted, delta), ...this.advance(open, delta)]
    }
    const block = contentIndex ?? this.block + 1
    this.block = Math.max(this.block, block)
    const id = assistantFrameId(turn, Math.max(0, this.message), block)
    /* 同一块被别的帧打断（插话 / 工具起头把它封了口）之后接着流：接回原来那一帧，不另起、也不清空已有的字 */
    const last = this.lastStream
    if (last !== null && last.id === id && last.kind === kind) {
      const resumed: Streaming = { ...last, since: 0 }
      return [appendOp(turn, resumed.step, id, resumed.emitted, delta), ...this.advance(resumed, delta)]
    }
    const step = stepId(turn, this.step)
    const created: Streaming = { id, kind, block, step, emitted: 0, since: 0 }
    return [streamStartOp(turn, step, kind, id), appendOp(turn, step, id, 0, delta), ...this.advance(created, delta)]
  }

  /**
   * 推进累加器，只在相位真的变了的时候补一条 meta.merge。
   * since 是「这一档相位从哪一刻开始」而不是「这一帧是什么时候」：进入 streaming 时取一次就冻结，
   * 于是同一相位的每个增量算出来逐字相同，下游 applyMetaMerge 的引用比对能判成没变。
   */
  private advance(open: Streaming, delta: string): TranscriptOperation[] {
    const emitted = open.emitted + delta.length
    const opened = open.since === 0
    const since = opened ? this.o.now() : open.since
    this.streaming = { ...open, emitted, since }
    this.lastStream = this.streaming
    if (!opened) return []
    return [
      {
        op: 'meta.merge',
        meta: {
          activity: 'turn',
          agent: {
            phase: {
              kind: 'streaming',
              turnId: this.turn,
              step: this.step,
              stepId: open.step,
              stream: open.kind === 'text' ? 'assistant' : 'thinking',
              since,
            },
          },
        },
      },
    ]
  }

  /** 工具调用开始：起工具前先封掉正在流的正文（工具与文本不同帧） */
  toolStart(call: {
    readonly toolCallId: string
    readonly toolName: string
    readonly args: unknown
    readonly intent?: string
  }): TranscriptOperation[] {
    if (!this.turnOpen) return []
    this.streaming = null
    const turn = turnId(this.turn)
    const step = stepId(turn, this.step)
    const id = `tool.${call.toolCallId}`
    this.tools.set(call.toolCallId, id)
    this.args.set(call.toolCallId, call.args)
    if (call.intent !== undefined && call.intent !== '') this.intents.set(call.toolCallId, call.intent)
    return [
      {
        op: 'frame.upsert',
        turnId: turn,
        stepId: step,
        frame: {
          kind: 'tool',
          frameId: id,
          toolCallId: call.toolCallId,
          name: call.toolName,
          state: 'running',
          input: call.args,
          ...(call.intent === undefined || call.intent === '' ? {} : { intent: call.intent }),
        },
      },
    ]
  }

  /** 工具的中间结果：同一帧覆盖，state 仍是 running。入参与意图要带回来（整格替换） */
  toolUpdate(call: {
    readonly toolCallId: string
    readonly toolName: string
    readonly partial: unknown
  }): TranscriptOperation[] {
    if (!this.turnOpen) return []
    const turn = turnId(this.turn)
    const step = stepId(turn, this.step)
    const id = this.tools.get(call.toolCallId) ?? `tool.${call.toolCallId}`
    const args = this.args.get(call.toolCallId)
    const intent = this.intents.get(call.toolCallId)
    return [
      {
        op: 'frame.upsert',
        turnId: turn,
        stepId: step,
        frame: {
          kind: 'tool',
          frameId: id,
          toolCallId: call.toolCallId,
          name: call.toolName,
          state: 'running',
          ...(args === undefined ? {} : { input: args }),
          ...(intent === undefined ? {} : { intent }),
          output: call.partial,
        },
      },
    ]
  }

  /** 工具结果：同一帧覆盖，state 从 running 走到 done 或 error（入参必须带回来） */
  toolEnd(call: {
    readonly toolCallId: string
    readonly toolName: string
    readonly result: unknown
    readonly isError?: boolean
  }): TranscriptOperation[] {
    if (!this.turnOpen) return []
    const turn = turnId(this.turn)
    const step = stepId(turn, this.step)
    const id = this.tools.get(call.toolCallId) ?? `tool.${call.toolCallId}`
    const failed = call.isError === true
    const args = this.args.get(call.toolCallId)
    const intent = this.intents.get(call.toolCallId)
    return [
      {
        op: 'frame.upsert',
        turnId: turn,
        stepId: step,
        frame: {
          kind: 'tool',
          frameId: id,
          toolCallId: call.toolCallId,
          name: call.toolName,
          state: failed ? 'error' : 'done',
          ...(args === undefined ? {} : { input: args }),
          ...(intent === undefined ? {} : { intent }),
          output: call.result,
          ...(failed ? { error: textOf(call.result) } : {}),
        },
      },
    ]
  }

  /** 一次 omp turn 结束：先收当前 step，再收 turn */
  turnEnd(
    outcome: 'completed' | 'cancelled' | 'failed',
    message: string | null,
    usage?: { readonly input: number; readonly output: number; readonly cacheRead: number },
  ): TranscriptOperation[] {
    if (!this.turnOpen) return []
    const turn = turnId(this.turn)
    const at = this.now()
    const ops: TranscriptOperation[] = []
    if (this.stepOpen) {
      ops.push({
        op: 'step.upsert',
        turnId: turn,
        step: {
          kind: 'step',
          stepId: stepId(turn, this.step),
          turnId: turn,
          ordinal: this.step,
          state: outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'interrupted' : 'completed',
          endedAt: at,
        },
      })
    }
    ops.push({
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: turn,
        ordinal: this.turn,
        state: outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : 'completed',
        origin: this.origin,
        ...(this.prompt === undefined ? {} : { prompt: this.prompt }),
        startedAt: this.startedAt,
        endedAt: at,
        ...(this.promptId === undefined ? {} : { triggerPromptId: this.promptId }),
        ...(this.attachmentIds.length > 0 ? { attachmentIds: this.attachmentIds } : {}),
        ...(message === null ? {} : { error: message }),
        ...(usage === undefined
          ? {}
          : {
              usage: {
                inputTokens: usage.input,
                outputTokens: usage.output,
                cachedTokens: usage.cacheRead,
              },
            }),
      },
    })
    ops.push({ op: 'meta.merge', meta: { activity: 'idle' } })
    this.abandonTurn()
    return ops
  }

  /**
   * 工具事件投影失败时的降级帧（R-02）：只改这一格，其余什么都不动。
   *
   * 本方法不得抛异常：入参全是已经确认过类型的字符串和布尔值，不读任何 unknown 值的内部。
   * 状态照实写（`ended` 三态），因为工具本身可能成功了，只是我们展示失败 —— 一律标成 error 是撒谎。
   */
  toolFallback(call: {
    readonly toolCallId: string
    readonly toolName: string
    /** null = 还没结束（start / update 失败）；true / false = 结束且是否出错 */
    readonly ended: boolean | null
  }): TranscriptOperation[] {
    if (!this.turnOpen) return []
    const turn = turnId(this.turn)
    const step = stepId(turn, this.step)
    const known = this.tools.get(call.toolCallId)
    const id = known ?? `tool.${call.toolCallId}`
    if (known === undefined) {
      // start 失败：照 toolStart 的规矩先封掉正在流的正文，再登记这一格
      this.streaming = null
      this.tools.set(call.toolCallId, id)
    }
    const args = this.args.get(call.toolCallId)
    const state = call.ended === null ? 'running' : call.ended ? 'error' : 'done'
    return [
      {
        op: 'frame.upsert',
        turnId: turn,
        stepId: step,
        frame: {
          kind: 'tool',
          frameId: id,
          toolCallId: call.toolCallId,
          name: call.toolName,
          state,
          ...(args === undefined ? {} : { input: args }),
          output: { content: [{ type: 'text', text: TOOL_FALLBACK_TEXT }] },
          ...(state === 'error' ? { error: TOOL_FALLBACK_TEXT } : {}),
        },
      },
    ]
  }

  /**
   * 放弃当前轮：只复位累加器，不产出 op（R-02）。
   *
   * 收尾时 `turnEnd` 没能执行完（投影成不成功）走它兜底；对已关闭的轮是空操作。
   * 字段清单与 `turnEnd` 末尾的复位段是同一份 —— 两处各写一遍就会漂移，所以只有这一个产地。
   */
  abandonTurn(): void {
    this.turnOpen = false
    this.turnAttachments = []
    this.stepOpen = false
    this.streaming = null
    this.tools.clear()
    this.args.clear()
    this.intents.clear()
    this.promptId = undefined
  }

  /** 一个上屏的提示帧（只有 warning / error；info 不上屏，见 R-09）：掉在当前 step 里，掉在哪就是哪 */
  notice(level: 'error' | 'warning', message: string, source?: string): TranscriptOperation[] {
    if (!this.turnOpen) return []
    const turn = turnId(this.turn)
    const step = stepId(turn, this.step)
    const id = frameId(step, this.frame)
    this.frame += 1
    return [
      {
        op: 'frame.upsert',
        turnId: turn,
        stepId: step,
        frame: {
          kind: 'notice',
          frameId: id,
          level,
          message,
          ...(source === undefined ? {} : { source }),
        },
      },
    ]
  }

  /**
   * 一次压缩开门：每次另起一格（compaction-live-<n>），关门落回这一格。
   *
   * 号不按轮号铸：同一轮里可以压好几次（overflow 重试、换一种方式再压），按轮号铸会让后一次盖掉前一次；
   * 也不与历史那条路的号（compaction-<轮>-<次>）同名 —— 整页重取时增量这几格会被整份换掉，不必对号。
   */
  compactionStart(input: { readonly reason?: unknown; readonly action?: unknown }): TranscriptOperation[] {
    const markerId = this.nextCompactionId()
    this.compactionOpen = markerId
    return this.marker({
      markerId,
      marker: 'compaction',
      payload: {
        state: 'running',
        ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
        ...(typeof input.action === 'string' ? { action: input.action } : {}),
      },
    })
  }

  /**
   * 关门：载荷由 compactionEndPayload 算好交进来；null（这次其实没压）就撤掉开门那一格。
   * 没见过开门（订阅晚于开门）也照样落一格：关门那一刻的结果比「什么都不说」强。
   */
  compactionEnd(payload: Record<string, unknown> | null): TranscriptOperation[] {
    const markerId = this.compactionOpen ?? this.nextCompactionId()
    this.compactionOpen = null
    if (payload === null) return [{ op: 'items.remove', ids: [markerId] }]
    return this.marker({ markerId, marker: 'compaction', payload })
  }

  private nextCompactionId(): string {
    this.compactionSeq += 1
    return `compaction-live-${String(this.compactionSeq)}`
  }

  /** 压缩/重试这类标记：走 marker.upsert，不绑 turn */
  marker(input: {
    readonly markerId: string
    readonly marker: string
    readonly payload?: unknown
  }): TranscriptOperation[] {
    return [
      {
        op: 'marker.upsert',
        item: {
          kind: 'marker',
          markerId: input.markerId,
          marker: input.marker,
          at: this.now(),
          ...(input.payload === undefined ? {} : { payload: input.payload }),
        },
      },
    ]
  }
}

/**
 * omp 的工具结果是 { content, details }，content 又是块数组；文本按与历史投影（history.ts 的 textOf）
 * 同一条规则取 —— 两处各写一份就是同一个规则的第二个产地。
 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  const content = (value as { readonly content?: unknown } | null)?.content ?? value
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as readonly { readonly type?: unknown; readonly text?: unknown }[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

function streamStartOp(turn: string, step: string, kind: 'text' | 'thinking', id: string): TranscriptOperation {
  return {
    op: 'frame.upsert',
    turnId: turn,
    stepId: step,
    frame:
      kind === 'text'
        ? { kind: 'text', role: 'assistant', frameId: id, text: '' }
        : { kind: 'thinking', frameId: id, text: '' },
  }
}

function appendOp(turn: string, step: string, id: string, offset: number, chunk: string): TranscriptOperation {
  return { op: 'append', target: { type: 'frame', turnId: turn, stepId: step, frameId: id }, offset, text: chunk }
}
