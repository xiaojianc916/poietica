/**
 * deepseek-harness 会话日志到条目的投影。
 *
 * 这是唯一认识 harness 会话词汇的地方。线上来的是一个完整的会话日志信封
 * （dsh-session 的 SessionEvent：type、seq、time、data），词汇有四十余种且可被
 * 插件声明合并扩展 —— 所以这里不穷举，只认这个程序真的画得出来的那几种，其余
 * 一律不落条目。官方的读者约定就是这一条：认不出的类型由信封上的 ignorable 决定
 * 能不能跳过，而我们跳过任何一种都不会画错，因为条目是从这些事件投影出来的，
 * 不是靠它们重建会话。
 *
 * 它一格新条目类型都没有引入：一条对话在屏幕上只有一种画法，两条线共用。
 */

import type { AcpToolCallContent, RunEvent } from '@poietica/agent-contract'
import type { ToolCallTimelineItem } from './timeline-contract'
import type { Draft } from './timeline-draft'
import { appendChunk, namespace, positionOf, push } from './timeline-draft'

/** 这条线上的方言帧。 */
export type HarnessFrame = Extract<RunEvent, { kind: 'harness_event' }>

export function applyHarnessFrame(draft: Draft, event: HarnessFrame): void {
  const envelope = read(event.event)

  if (envelope === undefined) {
    return
  }

  const scope = namespace(draft)

  switch (envelope.type) {
    case 'assistant/chunk': {
      /* 一步的每一个 token 各来一帧。同一步就是同一条消息 —— turn 与 step 在这条
         线上就是 ACP 那边 messageId 的位置，所以边界判据只有一条。 */
      const data = object(envelope.data)
      const chunk = object(data?.chunk)
      const text = string(chunk?.text)

      if (text === undefined) {
        return
      }

      const type =
        chunk?.type === 'text-delta'
          ? 'agent_text'
          : chunk?.type === 'reasoning-delta'
            ? 'agent_thought'
            : undefined

      if (type === undefined) {
        /* block-start / block-end / tool-call-delta / usage / finish：一段文字的
           边界、一次调用的原始参数流、用量与结局。前两件事由下面那两格与组装好的
           消息说全，后两件不属于转录（用量走会话状态通道）。 */
        return
      }

      appendChunk(draft, type, {
        at: event.at,
        id: `${scope}${type === 'agent_text' ? 'text' : 'thought'}-${String(event.seq)}`,
        message: `${String(number(data?.turn) ?? 0)}/${String(number(data?.step) ?? 0)}`,
        text,
      })

      return
    }

    case 'tool/call': {
      /* 模型请求了一次调用。arguments 是模型产出的原始 JSON 字符串，解析成对象是
         为了与另一条线的 rawInput 同形 —— 授权卡片与参数回显都读那一格。解析不了
         就原样留着：认不出就不认，不替模型改写它说过的话。 */
      const data = object(envelope.data)
      const callId = string(data?.callId)
      const name = string(data?.name)

      if (callId === undefined) {
        return
      }

      upsert(draft, `${scope}tool-${callId}`, {
        toolCallId: callId,
        title: name ?? callId,
        at: event.at,
        rawInput: parsed(string(data?.arguments)),
        status: 'pending',
      })

      return
    }

    case 'tool/result': {
      /* 这次调用的结局。callId 从结果块上读：ToolResultBlock 的 toolCallId 是这条
         线上取证过的那一格。带了 error 就是失败 —— 那是内部失败身份，模型看到的
         文本仍在 content 里，两样都不丢。 */
      const data = object(envelope.data)
      const message = object(data?.message)
      const blocks = array(message?.content)
      const result = blocks?.map(object).find((block) => block?.type === 'tool-result')
      const callId = string(result?.toolCallId)

      if (callId === undefined) {
        return
      }

      const failed = object(data?.error) !== undefined || result?.isError === true

      upsert(draft, `${scope}tool-${callId}`, {
        toolCallId: callId,
        title: callId,
        at: event.at,
        endedAt: event.at,
        content: shown(array(result?.content)),
        status: failed ? 'failed' : 'completed',
      })

      return
    }

    case 'turn/end': {
      /* 一轮的结局这条线自己也报一次，而 run_finished 的 stopReason 在它上面恒为
         end_turn（原生侧读的是 session.status 的空闲沿）。所以失败的理由只在这里，
         不说出来就等于把它吞掉。收口仍归 run_finished：一轮只有一个终点。 */
      const reason = object(object(envelope.data)?.reason)

      if (reason?.kind !== 'error') {
        return
      }

      const said = string(object(reason.error)?.message)

      push(draft, {
        type: 'error',
        id: `${scope}error-${String(event.seq)}`,
        turn: draft.runIndex,
        at: event.at,
        message: said ?? 'kind: error',
      })

      return
    }

    default: {
      /* 其余每一种都是日志的事实，不是转录的内容：轮与步的边界、组装好的消息
         （它的每一个字已经由上面那些 chunk 落过账，再落一遍就是同一句话说两遍）、
         请求头、路由、待办、压缩、钩子。忽略也要是一个决定，所以这里写出来。 */
      return
    }
  }
}

/**
 * 一次调用的一格一格补齐。
 *
 * 宣告与结果是同一件事的两次到达，协议按 callId 寻址，所以这里是一个 upsert，
 * 不是两份实现 —— 与另一条线上 tool_call 与 tool_call_update 的合并同一条规矩。
 * 已经记下的开始时刻与所属段号不再移动：一次调用属于它开始的那一段。
 */
function upsert(
  draft: Draft,
  id: string,
  facts: {
    readonly at: number
    readonly content?: readonly AcpToolCallContent[]
    readonly endedAt?: number
    readonly rawInput?: unknown
    readonly status: ToolCallTimelineItem['status']
    readonly title: string
    readonly toolCallId: string
  },
): void {
  const position = positionOf(draft, id)
  const found = position < 0 ? undefined : draft.items[position]
  const held = found?.type === 'tool_call' ? found : undefined

  const next: ToolCallTimelineItem = {
    type: 'tool_call',
    id,
    turn: held?.turn ?? draft.runIndex,
    at: held?.at ?? facts.at,
    toolCallId: facts.toolCallId,
    title: held?.title ?? facts.title,
    kind: held?.kind ?? 'other',
    status: facts.status,
    content: facts.content ?? held?.content ?? [],
    locations: held?.locations ?? [],
    startedAt: held?.startedAt ?? facts.at,
    ...(facts.rawInput === undefined
      ? held?.rawInput === undefined
        ? {}
        : { rawInput: held.rawInput }
      : { rawInput: facts.rawInput }),
    ...(facts.endedAt === undefined
      ? held?.endedAt === undefined
        ? {}
        : { endedAt: held.endedAt }
      : { endedAt: held?.endedAt ?? facts.endedAt }),
  }

  if (held === undefined) {
    push(draft, next)

    return
  }

  draft.items[position] = next
}

/** 一次调用产出的文字。图片这条线还没有取证过形状，所以不画。 */
function shown(blocks: readonly unknown[] | undefined): readonly AcpToolCallContent[] {
  if (blocks === undefined) {
    return []
  }

  const kept: AcpToolCallContent[] = []

  for (const block of blocks) {
    const text = string(object(block)?.text)

    if (object(block)?.type === 'text' && text !== undefined) {
      kept.push({ type: 'content', content: { type: 'text', text } })
    }
  }

  return kept
}

/**
 * 信封，认出来才收。
 *
 * 词汇开放，所以线上的东西在类型里是 unknown：这几个窄化函数是它进入模型的唯一
 * 关口，认不出的一律当没来过 —— 不抛、不猜、不半信半疑地建一条空条目。
 */
function read(value: unknown): { readonly type: string; readonly data?: unknown } | undefined {
  const envelope = object(value)
  const type = string(envelope?.type)

  return type === undefined ? undefined : { type, data: envelope?.data }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function array(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 模型产出的原始 JSON 字符串。认不出就原样留着。 */
function parsed(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
