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
  ): TranscriptOperation[] {
    const ordinal = this.#turn + 1
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
          origin: { kind: 'user' },
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
      open = { id: frameId(step, this.#frame), kind, step, emitted: 0 }
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
        this.#advance(open, delta),
      ]
    }

    return [
      appendOp(this.#turn, open.step, open.id, open.emitted, delta),
      this.#advance(open, delta),
    ]
  }

  #advance(open: Streaming, delta: string): TranscriptOperation {
    const next: Streaming = { ...open, emitted: open.emitted + delta.length }
    this.#streaming = next

    return {
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
            since: Date.now(),
          },
        },
      },
    }
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
  ): TranscriptOperation[] {
    if (!this.#turnOpen) {
      return []
    }

    const turn = turnId(this.#turn)
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
        ordinal: this.#turn,
        state:
          outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : 'completed',
        origin: { kind: 'user' },
        prompt: this.#prompt,
        startedAt: this.#startedAt,
        endedAt: at,
        ...(this.#promptId === undefined ? {} : { triggerPromptId: this.#promptId }),
        ...(this.#attachmentIds.length > 0 ? { attachmentIds: this.#attachmentIds } : {}),
        ...(message === undefined ? {} : { error: message }),
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
