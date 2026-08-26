import type { RunEvent } from '@poietica/agent-contract'

/*
 * 合成会话。
 *
 * 帧的形状与 crates/agent-runtime/src/frame.rs 记下的一致，所以基线量的是真管线：
 * 同一批帧既走重放（打开一条对话），也走增量（模型吐字）。不需要任何 agent 进程，
 * 也不需要一条真实的超长对话。
 */

export interface ConversationShape {
  /** 已经收口的轮次数。 */
  readonly turns: number
  /** 每轮正文分几段到达。 */
  readonly deltas: number
  /** 每隔几轮插一次工具调用；0 表示不插。 */
  readonly toolEvery: number
  /** 每段正文的字数下限。 */
  readonly width: number
}

function filler(width: number, seed: number): string {
  return `第${String(seed)}段合成正文，用来撑出真实的行高。`.repeat(
    Math.max(1, Math.ceil(width / 20)),
  )
}

/** 一条收口的会话，按轮次顺序。 */
export function closedConversation(shape: ConversationShape): readonly RunEvent[] {
  const events: RunEvent[] = []
  let at = 1_000

  for (let turn = 1; turn <= shape.turns; turn += 1) {
    let seq = 1

    at += 10
    events.push({
      kind: 'run_started',
      seq,
      at,
      sessionId: 'sess_perf',
      prompt: `第 ${String(turn)} 问：核对一遍构建命令与依赖表。`,
    })

    if (shape.toolEvery > 0 && turn % shape.toolEvery === 0) {
      const toolCallId = `call_${String(turn)}`

      seq += 1
      at += 10
      events.push({
        kind: 'kap_event',
        seq,
        at,
        payload: {
          type: 'tool.call.started',
          toolCallId,
          name: 'Read package.json',
          args: { path: 'package.json' },
          display: { kind: 'file_io', operation: 'read', path: 'package.json' },
        },
      })

      seq += 1
      at += 10
      events.push({
        kind: 'kap_event',
        seq,
        at,
        payload: { type: 'tool.result', toolCallId, output: filler(shape.width, turn) },
      })
    }

    for (let part = 0; part < shape.deltas; part += 1) {
      seq += 1
      at += 10
      events.push({
        kind: 'kap_event',
        seq,
        at,
        payload: { type: 'assistant.delta', delta: filler(shape.width, part) },
      })
    }

    seq += 1
    at += 10
    events.push({ kind: 'run_finished', seq, at, stopReason: 'completed' })
  }

  return events
}

/**
 * 一轮正在跑的开头。
 *
 * seq 从一个远高于历史的号起算：每一轮的 seq 各自从一编，所以这样落下来的实时
 * 轮次不会撞上重放窗口的去重。
 */
export function liveTurn(seq: number, at: number): RunEvent {
  return {
    kind: 'run_started',
    seq,
    at,
    sessionId: 'sess_perf',
    prompt: '最后一问：说明刚才的核对结果。',
  }
}

/** 这一轮的第 index 段正文。 */
export function liveDelta(seq: number, at: number, index: number, width: number): RunEvent {
  return {
    kind: 'kap_event',
    seq,
    at,
    payload: { type: 'assistant.delta', delta: filler(width, index) },
  }
}
