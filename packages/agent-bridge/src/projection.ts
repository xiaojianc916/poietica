/*
 * omp 的会话事件 → transcript 的 ops。
 *
 * 投影器持有流式累加状态，因为 transcript 的 append 认 offset（ops/apply.ts 的
 * appendAtOffset 要求 offset 不大于已有长度，否则记 gap）。每个流式帧因此要记住
 * 自己已经发出多少字，下一条增量才接得上。
 *
 * 一次 omp turn 的形状（packages/agent/src/types.ts 的 AgentEvent）：
 *   turn_start → message_update(text_delta/thinking_delta…) → tool_execution_start
 *   → tool_execution_end → turn_end → （循环）→ agent_end
 * transcript 里一次 omp turn 就是一个 turn；正文与每次工具调用各占一个 step。
 *
 * 纯状态机，不碰 SDK：能被单测逐条钉住，不必起进程。
 */

import type { TranscriptOperation } from '@poietica/transcript'
import { frameId, stepId, turnId } from '@poietica/transcript'

type Streaming = {
  readonly id: string
  readonly kind: 'text' | 'thinking'
  readonly step: string
  /** 已经发出的字符数，也就是下一条 append 的 offset。 */
  readonly emitted: number
  /**
   * 这一档相位是从哪一刻开始的；0 表示「还没报过」。
   *
   * 冻结而不是每帧取新时刻：下游按引用比对判「有没有变」，every-delta 的新时刻会让
   * 每一条相位都算变化（见 #advance）。
   */
  readonly since: number
}

export class TranscriptProjector {
  #turn = 0
  #step = 0
  #frame = 0
  #turnOpen = false
  #stepOpen = false
  #streaming: Streaming | null = null
  #tools = new Map<string, string>()
  /* 入参与意图按 toolCallId 记着：结果那一帧要一起带回去（覆盖是整格替换）。 */
  #args = new Map<string, unknown>()
  #intents = new Map<string, string>()
  /* turn.upsert 是整格替换（ops/apply.ts 的 applyTurnUpsert），收轮时得把开轮写下的
   * 那几格原样带回去，否则 prompt 会被自己的收尾覆盖成空。 */
  #prompt = ''
  #promptId: string | undefined
  #startedAt = ''
  #attachmentIds: readonly string[] = []

  get turnOrdinal(): number {
    return this.#turn
  }

  get isTurnOpen(): boolean {
    return this.#turnOpen
  }

  /**
   * 把流式累加器摆到屏幕上已有的位置：下一轮从 `ordinal + 1` 起号。
   *
   * 屏幕上的号是**显示经过里的位置**（重开一条会话时重排过），而增量这条路的号是
   * 它自己从头数下来的。两者不对齐，接着说话就会用旧号盖掉屏幕上已有的轮 ——
   * 那正是「重开一条长对话，第一句话把屏幕顶掉一截」这件事。
   *
   * 只许在没开着轮时调（收尾那一段会断言这一点）：开着轮时改号，这一轮自己就对不上了。
   */
  seat(ordinal: number): void {
    if (this.#turnOpen) {
      return
    }

    this.#turn = ordinal
  }

  /**
   * 一条用户消息：开一个新 turn，正文落在它下面第一个 step 的第一帧。
   *
   * `promptId` 是提交时本机账本签的那个号，挂成 `triggerPromptId` —— 屏幕靠它把这
   * 一格与「刚提交还没落地」的那条记录认成同一件事（transcript-projector.ts 的
   * knownPromptIds）。不挂的话那条记录永远收不掉：发送键一直转，取消还会说
   * 「消息仍在提交」。
   */
  userTurn(
    text: string,
    attachmentIds: readonly string[] = [],
    promptId?: string,
    startedAt: string = now(),
    /* 屏幕上已有位置时在这里指定（见 seat）；不指定就用流式累加器自己的下一个号。 */
    at?: { readonly ordinal: number; readonly prompt?: string },
    /*
     * 这一句挂了哪几个技能。写进 origin 是为了让**屏幕**画得出那几枚 chip ——
     * 缺了它，「挂了技能」这件事在任何一帧里都不存在（transcript-projector 的
     * skillNamesOf 只读 origin.payload.skillActivations，而它从前全仓无生产者）。
     *
     * 形状对齐 crates/agent-client/src/frame.rs 的 PromptAdmitted.skills：name + args。
     */
    skills: readonly { readonly name: string; readonly args?: string }[] = [],
  ): TranscriptOperation[] {
    const ordinal = at?.ordinal ?? this.#turn + 1
    const turn = turnId(ordinal)
    const step = stepId(turn, 0)
    const id = frameId(step, 0)

    this.#turn = ordinal
    this.#step = 0
    this.#frame = 1
    this.#turnOpen = true
    this.#stepOpen = true
    this.#streaming = null
    this.#tools.clear()
    this.#args.clear()
    this.#intents.clear()
    this.#prompt = text
    this.#promptId = promptId
    this.#startedAt = startedAt
    this.#attachmentIds = attachmentIds

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
                    skillActivations: skills.map((skill) => ({
                      skillName: skill.name,
                      ...(skill.args === undefined ? {} : { skillArgs: skill.args }),
                    })),
                  },
                },
          prompt: text,
          startedAt: this.#startedAt,
          ...(promptId === undefined ? {} : { triggerPromptId: promptId }),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        },
      },
      {
        op: 'step.upsert',
        turnId: turn,
        step: {
          kind: 'step',
          stepId: step,
          turnId: turn,
          ordinal: 0,
          state: 'running',
          startedAt: this.#startedAt,
        },
      },
      {
        op: 'frame.upsert',
        turnId: turn,
        stepId: step,
        frame: {
          kind: 'text',
          role: 'user',
          frameId: id,
          text,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        },
      },
    ]
  }

  /**
   * 一句插话（steer / followUp 落到上下文里的那一下）。
   *
   * 与 `userTurn` 的分野是**开不开新轮**：开着一轮时这句话是那一轮里的一句（模型在
   * 工具批次之间看见它，然后接着干同一轮的活），所以它进当前 step；没开着一轮时
   * （followUp 在轮终之后被排成下一轮）这句话就是开场白，退回 `userTurn`。
   *
   * 正文帧必须先封掉正在流的那一帧：不封，插话会夹在 assistant 同一帧的字符之间，
   * 屏幕上就是一句话被劈成两半。`origin.kind = 'user'` 是投影层认「这是人说的话」
   * 的唯一判据（transcript-projector.ts 的 sourceOfFrame）。
   */
  steeredFrame(
    text: string,
    attachmentIds: readonly string[] = [],
    at: string = now(),
  ): TranscriptOperation[] {
    if (!this.#turnOpen) {
      return this.userTurn(text, attachmentIds, undefined, at)
    }

    this.#streaming = null

    const step = stepId(turnId(this.#turn), this.#step)
    const id = frameId(step, this.#frame)
    this.#frame += 1

    return [
      {
        op: 'frame.upsert',
        turnId: turnId(this.#turn),
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

  /** assistant 正文增量。 */
  textDelta(delta: string): TranscriptOperation[] {
    return this.#stream('text', delta)
  }

  /** 思维链增量，与正文同一条追加路，只是帧的种类不同。 */
  thinkingDelta(delta: string): TranscriptOperation[] {
    return this.#stream('thinking', delta)
  }

  #stream(kind: 'text' | 'thinking', delta: string): TranscriptOperation[] {
    if (!this.#turnOpen) {
      return []
    }

    let open = this.#streaming

    /* 换了一种流（正文↔思维链）就另起一帧：一帧只装一种东西。 */
    if (open === null || open.kind !== kind) {
      const step = stepId(turnId(this.#turn), this.#step)
      open = { id: frameId(step, this.#frame), kind, step, emitted: 0, since: 0 }
      this.#frame += 1
      this.#streaming = open

      const created: TranscriptOperation[] =
        kind === 'text'
          ? [
              {
                op: 'frame.upsert',
                turnId: turnId(this.#turn),
                stepId: step,
                frame: { kind: 'text', role: 'assistant', frameId: open.id, text: '' },
              },
            ]
          : [
              {
                op: 'frame.upsert',
                turnId: turnId(this.#turn),
                stepId: step,
                frame: { kind: 'thinking', frameId: open.id, text: '' },
              },
            ]

      return [
        ...created,
        appendOp(this.#turn, open.step, open.id, 0, delta),
        ...this.#advance(open, delta),
      ]
    }

    return [
      appendOp(this.#turn, open.step, open.id, open.emitted, delta),
      ...this.#advance(open, delta),
    ]
  }

  /*
   * 推进流式累加器，并只在相位真的变了的时候补一条 meta.merge。
   *
   * `since` 是「这一档相位从哪一刻开始」，不是「这一帧是什么时候」：进入 streaming 时
   * 取一次就冻结，于是同一相位的每个增量算出来逐字相同，下游 applyMetaMerge 的引用比对
   * 因此能判成「没变」。
   *
   * 此前这里写 Date.now()：每条增量都造一个全新相位对象，一帧里 append 与 meta.merge
   * 严格交替（实测 meta.merge 占 55% 的字节、47% 的 op 数），而它一个字的正文都没带；
   * 下游每次都得合并、每次都被判成有变化，于是每批 ops 必然叫醒一次 React。
   */
  #advance(open: Streaming, delta: string): TranscriptOperation[] {
    const emitted = open.emitted + delta.length
    const opened = open.since === 0
    const since = opened ? Date.now() : open.since
    this.#streaming = { ...open, emitted, since }

    if (!opened) {
      return []
    }

    return [
      {
        op: 'meta.merge',
        meta: {
          activity: 'turn',
          agent: {
            phase: {
              kind: 'streaming',
              turnId: this.#turn,
              step: this.#step,
              stepId: open.step,
              stream: open.kind === 'text' ? 'assistant' : 'thinking',
              since,
            },
          },
        },
      },
    ]
  }

  /**
   * 工具调用开始。
   *
   * omp 的 `tool_execution_start` 只给 toolCallId/toolName/args，帧先落 running；
   * 结果到了按同一 frameId 覆盖。
   */
  toolStart(call: {
    readonly toolCallId: string
    readonly toolName: string
    readonly args: unknown
    readonly intent?: string
  }): TranscriptOperation[] {
    if (!this.#turnOpen) {
      return []
    }

    /* 工具调用与文本不同帧：起工具前先封掉正在流的正文。 */
    this.#streaming = null

    const step = stepId(turnId(this.#turn), this.#step)
    const id = `tool.${call.toolCallId}`
    this.#tools.set(call.toolCallId, id)
    this.#args.set(call.toolCallId, call.args)
    if (call.intent !== undefined && call.intent !== '') {
      this.#intents.set(call.toolCallId, call.intent)
    }

    return [
      {
        op: 'frame.upsert',
        turnId: turnId(this.#turn),
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

  /**
   * 工具的中间结果：同一帧覆盖，state 仍是 running。
   *
   * 官方在 `tool_execution_update` 里发 partialResult（bash 的 tail 按 50ms 节流、
   * edit 的实时 diff 走 openArgStream 的 tool_stream_update），从前这一帧被
   * handleEvent 的 default 整条丢掉 —— 一条跑三分钟的 bash 屏幕上从「运行中」
   * 直接跳到终态。接上它不改契约：frame.upsert 是整格替换，tool 帧本来就有 output。
   *
   * 入参与意图照旧要带回来（整格替换），否则中间态那一刻主语会消失。
   */
  toolUpdate(call: {
    readonly toolCallId: string
    readonly toolName: string
    readonly partial: unknown
  }): TranscriptOperation[] {
    if (!this.#turnOpen) {
      return []
    }

    const step = stepId(turnId(this.#turn), this.#step)
    const id = this.#tools.get(call.toolCallId) ?? `tool.${call.toolCallId}`
    const args = this.#args.get(call.toolCallId)
    const intent = this.#intents.get(call.toolCallId)

    return [
      {
        op: 'frame.upsert',
        turnId: turnId(this.#turn),
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

  /**
   * 工具结果：同一帧覆盖，state 从 running 走到 done 或 error。
   *
   * 覆盖是**整格替换**（ops/apply.ts 的 applyFrameUpsert），所以入参必须跟着带回来 ——
   * 不带就等于在结果到达那一刻把 path/command 抹掉，投影层再取不到主语与那一句话，
   * 一次读文件于是退成没有路径的「读取文件」，一面也因此空了。
   */
  toolEnd(call: {
    readonly toolCallId: string
    readonly toolName: string
    readonly result: unknown
    readonly isError?: boolean
  }): TranscriptOperation[] {
    if (!this.#turnOpen) {
      return []
    }

    const step = stepId(turnId(this.#turn), this.#step)
    const id = this.#tools.get(call.toolCallId) ?? `tool.${call.toolCallId}`
    const failed = call.isError === true
    const args = this.#args.get(call.toolCallId)
    const intent = this.#intents.get(call.toolCallId)

    return [
      {
        op: 'frame.upsert',
        turnId: turnId(this.#turn),
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
          ...(failed ? { error: text(call.result) } : {}),
        },
      },
    ]
  }

  /**
   * 一次 omp turn 结束：收掉当前 step 与 turn 的状态。
   *
   * 一次 omp turn 里可能有多段 assistant 文本与多次工具调用，它们按顺序各占一个
   * step，所以这里先把当前 step 收掉，再把 turn 收掉。
   */
  turnEnd(
    outcome: 'completed' | 'cancelled' | 'failed',
    message?: string,
    endedAt: string = now(),
    usage?: { readonly input: number; readonly output: number; readonly cacheRead: number },
    /* 屏幕上这一格占的位置（见 seat）。指定时以它为准：号是按位置算出来的。 */
    seat?: { readonly ordinal: number; readonly prompt?: string },
  ): TranscriptOperation[] {
    if (!this.#turnOpen) {
      return []
    }

    const ordinal = seat?.ordinal ?? this.#turn
    const turn = turnId(ordinal)
    const at = endedAt
    const ops: TranscriptOperation[] = []

    if (this.#stepOpen) {
      ops.push({
        op: 'step.upsert',
        turnId: turn,
        step: {
          kind: 'step',
          stepId: stepId(turn, this.#step),
          turnId: turn,
          ordinal: this.#step,
          state:
            outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'interrupted' : 'completed',
          endedAt: at,
        },
      })
    }

    ops.push({
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: turn,
        ordinal,
        state:
          outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : 'completed',
        origin: { kind: 'user' },
        prompt: seat?.prompt ?? this.#prompt,
        startedAt: this.#startedAt,
        endedAt: at,
        ...(this.#promptId === undefined ? {} : { triggerPromptId: this.#promptId }),
        ...(this.#attachmentIds.length > 0 ? { attachmentIds: this.#attachmentIds } : {}),
        ...(message === undefined ? {} : { error: message }),
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

    this.#turnOpen = false
    this.#stepOpen = false
    this.#streaming = null
    this.#tools.clear()
    this.#args.clear()
    this.#intents.clear()
    this.#promptId = undefined
    /* 收在座位上：下一轮从它后面接着排，不与屏幕上已有的那一格撞号。 */
    this.#turn = ordinal

    return ops
  }

  /** 一个错误通知帧：不绑 turn，掉在哪就是哪。 */
  notice(
    level: 'error' | 'warning' | 'info',
    message: string,
    source?: string,
  ): TranscriptOperation[] {
    if (!this.#turnOpen) {
      return []
    }

    const step = stepId(turnId(this.#turn), this.#step)
    const id = frameId(step, this.#frame)
    this.#frame += 1

    return [
      {
        op: 'frame.upsert',
        turnId: turnId(this.#turn),
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
}

/**
 * 一次未结交互的 upsert：审批与提问共用这一条路。
 *
 * 交互不绑 turn：它是拦在「继续」前面的一道闸，人答完之前那一轮根本没收。
 * 所以它是投影器上一个独立的构建函数，不碰流式累加状态。
 *
 * 这一条 op 是屏幕看得见审批的唯一前提：`phaseOf` 靠 snapshot.interactions 里有没有
 * pending 决出 `awaiting_permission` / `awaiting_question`，而输入框那一带靠那个相位
 * 才把带子挂出来（transcript-projector.ts 的 phaseOf / assistant-surface.tsx）。
 */
export function interactionOp(input: {
  readonly interactionId: string
  readonly kind: 'approval' | 'question'
  readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed'
  readonly toolCallId?: string
  /** 原始请求：提问那一路把题组装在这里（投影层按 `questions` 取）。 */
  readonly request?: unknown
  readonly response?: unknown
}): TranscriptOperation[] {
  return [
    {
      op: 'interaction.upsert',
      interaction: {
        interactionId: input.interactionId,
        interactionKind: input.kind,
        state: input.state,
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
        ...(input.request === undefined ? {} : { request: input.request }),
        ...(input.response === undefined ? {} : { response: input.response }),
      },
    },
  ]
}

/**
 * 一次标记的 upsert：上下文压缩走这一条。
 *
 * 与交互同形：不绑 turn 的独立构建函数，不碰流式累加状态。压缩也一样不绑某一轮 ——
 * agent 压的是上下文，不是「这一轮做了什么」。
 *
 * 号必须稳定：开门与关门是同一行的两次 upsert，换号会在屏幕上多出一行。
 */
export function markerOp(input: {
  readonly markerId: string
  readonly marker: string
  readonly payload?: unknown
  readonly at?: string
}): TranscriptOperation[] {
  return [
    {
      op: 'marker.upsert',
      item: {
        kind: 'marker',
        markerId: input.markerId,
        marker: input.marker,
        at: input.at ?? now(),
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      },
    },
  ]
}

/**
 * 一次附件的 upsert：回放历史里的图片走这一条。
 *
 * 与交互、标记同形：不绑 turn 的独立构建函数。图片挂在用户那一轮上，但它自己的事实
 * （媒体类型、像素、名字）与轮无关，所以另立一格，由 `userTurn` 的 attachmentIds 引用。
 *
 * 像素用 `url` 源直接给：omp 读会话文件时已经把 blob 引用换回 base64，所以这一格是
 * data URL，界面直接画得出来，不必再开一条取字节的通道。
 */
export function attachmentOp(input: {
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

function appendOp(
  turn: number,
  step: string,
  id: string,
  offset: number,
  chunk: string,
): TranscriptOperation {
  return {
    op: 'append',
    target: { type: 'frame', turnId: turnId(turn), stepId: step, frameId: id },
    offset,
    text: chunk,
  }
}

const now = (): string => new Date().toISOString()

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
