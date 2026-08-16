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
 * 信封在类型里是 unknown，所以取值只有一条路：at 按名字往下走，走不通就当没来过。
 * 不抛、不猜、不半信半疑地建一条空条目。
 *
 * 它一格新条目类型都没有引入：一条对话在屏幕上只有一种画法，两条线共用。
 */

import type { AcpPlanEntry, AcpToolCallContent, RunEvent } from '@poietica/agent-contract'
import type { PlanItem, ToolCallTimelineItem } from './timeline-contract'
import type { Draft } from './timeline-draft'
import { appendChunk, namespace, positionOf, push } from './timeline-draft'

/** 这条线上的方言帧。 */
export type HarnessFrame = Extract<RunEvent, { kind: 'harness_event' }>

export function applyHarnessFrame(draft: Draft, event: HarnessFrame): void {
  const type = string(at(event.event, 'type'))

  if (type === undefined) {
    return
  }

  const data = at(event.event, 'data')
  const scope = namespace(draft)

  switch (type) {
    case 'assistant/chunk': {
      /* 一步的每一个 token 各来一帧。同一步就是同一条消息 —— turn 与 step 在这条
         线上就是 ACP 那边 messageId 的位置，所以边界判据只有一条。 */
      const kind = at(data, 'chunk', 'type')
      const text = string(at(data, 'chunk', 'text'))

      const item =
        kind === 'text-delta'
          ? 'agent_text'
          : kind === 'reasoning-delta'
            ? 'agent_thought'
            : undefined

      if (item === undefined || text === undefined) {
        /* block-start / block-end / tool-call-delta / usage / finish：一段文字的
           边界、一次调用的原始参数流、用量与结局。前两件事由下面那两格与组装好的
           消息说全，后两件不属于转录（用量走会话状态通道）。 */
        return
      }

      const turn = String(number(at(data, 'turn')) ?? 0)
      const step = String(number(at(data, 'step')) ?? 0)

      appendChunk(draft, item, {
        at: event.at,
        id: `${scope}${item === 'agent_text' ? 'text' : 'thought'}-${String(event.seq)}`,
        message: `${turn}/${step}`,
        text,
      })

      return
    }

    case 'tool/call': {
      /* 模型请求了一次调用。arguments 是模型产出的原始 JSON 字符串，解析成对象是
         为了与另一条线的 rawInput 同形 —— 授权卡片与参数回显都读那一格。解析不了
         就原样留着：认不出就不认，不替模型改写它说过的话。 */
      const callId = string(at(data, 'callId'))

      if (callId === undefined) {
        return
      }

      upsert(draft, `${scope}tool-${callId}`, {
        toolCallId: callId,
        title: string(at(data, 'name')) ?? callId,
        at: event.at,
        rawInput: parsed(string(at(data, 'arguments'))),
        status: 'pending',
      })

      return
    }

    case 'tool/result': {
      /* 这次调用的结局。callId 从结果块上读：ToolResultBlock 的 toolCallId 是这条
         线上取证过的那一格。带了 error 就是失败 —— 那是内部失败身份，模型看到的
         文本仍在 content 里，两样都不丢。 */
      const blocks = array(at(data, 'message', 'content')) ?? []
      const result = blocks.find((block) => at(block, 'type') === 'tool-result')
      const callId = string(at(result, 'toolCallId'))

      if (callId === undefined) {
        return
      }

      const failed = at(data, 'error') !== undefined || at(result, 'isError') === true

      upsert(draft, `${scope}tool-${callId}`, {
        toolCallId: callId,
        title: callId,
        at: event.at,
        endedAt: event.at,
        content: shown(array(at(result, 'content'))),
        status: failed ? 'failed' : 'completed',
      })

      return
    }

    case 'todo/write': {
      /* 这条线整份替换待办表，协议那边的 plan 也是整份替换（PlanEntry 的官方措辞：
         客户端每次更新都整份替换）。同一件事只许有一条画法，所以落同一种条目、
         同一个 id、同一条替换规矩 —— 一段里只有一份计划，后一段不改写前一段。 */
      const id = `${scope}plan`
      const entries = (array(at(data, 'todos')) ?? []).flatMap((todo) => entryOf(todo))
      const plan: PlanItem = { type: 'plan', id, turn: draft.runIndex, at: event.at, entries }
      const position = positionOf(draft, id)

      if (position < 0) {
        push(draft, plan)

        return
      }

      draft.items[position] = plan

      return
    }

    case 'turn/end': {
      /* 一轮的结局这条线自己也报一次，而 run_finished 的 stopReason 在它上面恒为
         end_turn（原生侧读的是 session.status 的空闲沿）。所以失败的理由只在这里，
         不说出来就等于把它吞掉。收口仍归 run_finished：一轮只有一个终点。 */
      if (at(data, 'reason', 'kind') !== 'error') {
        return
      }

      push(draft, {
        type: 'error',
        id: `${scope}error-${String(event.seq)}`,
        turn: draft.runIndex,
        at: event.at,
        message: string(at(data, 'reason', 'error', 'message')) ?? 'kind: error',
      })

      return
    }

    default: {
      /* 其余每一种都是日志的事实，不是转录的内容：轮与步的边界、组装好的消息
         （它的每一个字已经由上面那些 chunk 落过账，再落一遍就是同一句话说两遍）、
         请求头、路由、压缩、钩子。忽略也要是一个决定，所以这里写出来。 */
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
    /* 缺席和「值为 undefined」在 exactOptionalPropertyTypes 下不是一回事。 */
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

/** 协议认的三档状态。名字不在其中就不落 —— 认不出的状态不许猜成 pending。 */
const STATUSES: readonly AcpPlanEntry['status'][] = ['pending', 'in_progress', 'completed']

/**
 * 一条待办到一格计划条目。
 *
 * 三档状态的名字两边逐字相同（dsh-session 的 TodoItem 与协议的 PlanEntryStatus 都是
 * pending / in_progress / completed），所以这里是一次转录，不是一张要维护的映射表。
 *
 * 优先级这条线不报，而协议那一格必填。填 medium 是「没报」的占位，不是被观察到的
 * 轻重缓急 —— 屏幕不许拿它当事实读。
 */
function entryOf(todo: unknown): readonly AcpPlanEntry[] {
  const content = string(at(todo, 'content'))
  const said = string(at(todo, 'status'))
  const status = STATUSES.find((known) => known === said)

  return content === undefined || status === undefined
    ? []
    : [{ content, priority: 'medium', status }]
}

/** 一次调用产出的文字。图片这条线还没有取证过形状，所以不画。 */
function shown(blocks: readonly unknown[] | undefined): readonly AcpToolCallContent[] {
  if (blocks === undefined) {
    return []
  }

  const kept: AcpToolCallContent[] = []

  for (const block of blocks) {
    const text = string(at(block, 'text'))

    if (at(block, 'type') === 'text' && text !== undefined) {
      kept.push({ type: 'content', content: { type: 'text', text } })
    }
  }

  return kept
}

/**
 * 按名字往开放数据里走一层或几层，走不通就是没有。
 *
 * 词汇归 harness 那侧，所以线上的东西在类型里是 unknown。取值集中在这一个函数里，
 * 于是「哪些格被读过」在这个文件里是数得出来的 —— 散在各处的类型断言做不到这件事。
 */
function at(value: unknown, ...path: readonly string[]): unknown {
  let held = value

  for (const key of path) {
    if (typeof held !== 'object' || held === null || Array.isArray(held)) {
      return undefined
    }

    held = (held as Record<string, unknown>)[key]
  }

  return held
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
