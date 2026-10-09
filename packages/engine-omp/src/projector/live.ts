import { frameId, stepId, type TranscriptOperation, turnId } from '@poietica/transcript'

/** 工具帧降级时显示的正文（状态照实，正文换成这句；R-02 §2.5） */
export const TOOL_FALLBACK_TEXT = '这一步的内容无法显示（详情已写入日志）'

interface Streaming {
  readonly id: string
  readonly kind: 'text' | 'thinking'
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
 * omp 的会话事件 → transcript 的 ops（12 页 §9.1，迁移自 legacy projection.ts 的 TranscriptProjector）。
 *
 * 它只维护指针：当前 turn/step 的号，以及每个流式帧已经发出了多少字。除此之外没有任何副作用：
 * 不发事件、不做 I/O、不写 console。append 认 offset，offset 大于已有长度就是缺口（TranscriptGapError），
 * 所以每个流式帧都要记住已发出的字数。
 */
export class LiveProjector {
  private turn = 0
  private step = 0
  private frame = 0
  private turnOpen = false
  private stepOpen = false
  private streaming: Streaming | null = null
  private readonly tools = new Map<string, string>()
  private readonly args = new Map<string, unknown>()
  private readonly intents = new Map<string, string>()
  private prompt = ''
  private promptId: string | undefined
  private startedAt = ''
  private attachmentIds: readonly string[] = []

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

  /**
   * 把累加器摆到屏幕上已有的位置：下一轮从 ordinal + 1 起号。
   * 只许在没开着轮时调：屏幕上的号是显示经过里的位置，增量这条路的号是它自己数的，两者不对齐就会盖掉已有的轮。
   */
  seat(ordinal: number): void {
    if (this.turnOpen) return
    this.turn = ordinal
  }

  /**
   * 一张图片的附件条目（12 页 §7.4 第 3 步：每张图片先 attachmentOp 再 userTurn）。
   * 像素用 url 源直接给（data URL）：omp 读会话时已经把 blob 换成内联 base64，界面直接画得出来。
   */
  attachmentOp(input: {
    readonly attachmentId: string
    readonly mediaType: string
    readonly dataUrl: string
    readonly name?: string
  }): TranscriptOperation[] {
    return [
      {
        op: 'attachment.upsert',
        attachment: {
          attachmentId: input.attachmentId,
          mediaType: input.mediaType,
          source: { kind: 'url', url: input.dataUrl },
          ...(input.name === undefined ? {} : { name: input.name }),
        },
      },
    ]
  }

  /** 一条用户消息：开一个新 turn，正文落在它下面第一个 step 的第一帧 */
  userTurn(input: {
    readonly text: string
    readonly attachmentIds?: readonly string[]
    readonly promptId?: string
    readonly skills?: readonly string[]
  }): TranscriptOperation[] {
    const attachmentIds = input.attachmentIds ?? []
    const skills = input.skills ?? []
    const ordinal = this.turn + 1
    const turn = turnId(ordinal)
    const at = this.now()
    this.turn = ordinal
    this.step = 0
    this.frame = 1
    this.turnOpen = true
    this.stepOpen = true
    this.streaming = null
    this.tools.clear()
    this.args.clear()
    this.intents.clear()
    this.prompt = input.text
    this.promptId = input.promptId
    this.startedAt = at
    this.attachmentIds = attachmentIds
    return [
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn',
          turnId: turn,
          ordinal,
          state: 'running',
          origin:
            skills.length === 0
              ? { kind: 'user' }
              : {
                  kind: 'user',
                  payload: {
                    kind: 'skill_activation',
                    trigger: 'user-slash',
                    skillActivations: skills.map((name) => ({ skillName: name })),
                  },
                },
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
      {
        op: 'frame.upsert',
        turnId: turn,
        stepId: stepId(turn, 0),
        frame: {
          kind: 'text',
          role: 'user',
          frameId: frameId(stepId(turn, 0), 0),
          text: input.text,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        },
      },
    ]
  }

  /** 一句插话：开着一轮时进当前 step 并封掉正在流的那一帧；没开着就退回 userTurn */
  steeredFrame(text: string, attachmentIds: readonly string[] = []): TranscriptOperation[] {
    if (!this.turnOpen) return this.userTurn({ text, attachmentIds })
    this.streaming = null
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

  textDelta(delta: string): TranscriptOperation[] {
    return this.stream('text', delta)
  }

  thinkingDelta(delta: string): TranscriptOperation[] {
    return this.stream('thinking', delta)
  }

  private stream(kind: 'text' | 'thinking', delta: string): TranscriptOperation[] {
    if (!this.turnOpen) return []
    const open = this.streaming
    const turn = turnId(this.turn)
    const step = stepId(turn, this.step)
    if (open === null || open.kind !== kind) {
      const created: Streaming = { id: frameId(step, this.frame), kind, step, emitted: 0, since: 0 }
      this.frame += 1
      this.streaming = created
      const start: TranscriptOperation =
        kind === 'text'
          ? {
              op: 'frame.upsert',
              turnId: turn,
              stepId: step,
              frame: { kind: 'text', role: 'assistant', frameId: created.id, text: '' },
            }
          : {
              op: 'frame.upsert',
              turnId: turn,
              stepId: step,
              frame: { kind: 'thinking', frameId: created.id, text: '' },
            }
      return [start, appendOp(turn, step, created.id, 0, delta), ...this.advance(created, delta)]
    }
    return [appendOp(turn, open.step, open.id, open.emitted, delta), ...this.advance(open, delta)]
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
        origin: { kind: 'user' },
        prompt: this.prompt,
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
   * 工具事件投影失败时的降级帧（R-02 §2.5）：只改这一格，其余什么都不动。
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
   * 放弃当前轮：只复位累加器，不产出 op（R-02 §2.5）。
   *
   * 收尾时 `turnEnd` 没能执行完（投影成不成功）走它兜底；对已关闭的轮是空操作。
   * 字段清单与 `turnEnd` 末尾的复位段是同一份 —— 两处各写一遍就会漂移，所以只有这一个产地。
   */
  abandonTurn(): void {
    this.turnOpen = false
    this.stepOpen = false
    this.streaming = null
    this.tools.clear()
    this.args.clear()
    this.intents.clear()
    this.promptId = undefined
  }

  /** 一个错误通知帧：不绑 turn，掉在哪就是哪 */
  notice(level: 'error' | 'warning' | 'info', message: string, source?: string): TranscriptOperation[] {
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

  /** 起一段新的 assistant step（一次 omp turn 里可能有多段正文与多次工具调用） */
  nextStep(): void {
    this.step += 1
    this.frame = 0
    this.streaming = null
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

function appendOp(turn: string, step: string, id: string, offset: number, chunk: string): TranscriptOperation {
  return { op: 'append', target: { type: 'frame', turnId: turn, stepId: step, frameId: id }, offset, text: chunk }
}
