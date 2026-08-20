/**
 * kap 方言到条目的投影。
 *
 * 唯一认识 kap 的地方：事件载荷里哪个字段叫什么、文本增量往哪条消息上拼、
 * 一次工具调用的四个生命周期事件怎么合成一次 upsert —— 全收在这一个文件里，
 * 别处不该再出现对 kap 字段名的引用。一轮的起止与审批归 projection.ts。
 *
 * 载荷形状的唯一权威是上游 kap-server 的 protocol/events-zod.ts（快照钉在
 * contracts/kap）。这里读的每一个字段都应该能在那份文件里找到。
 */

import type {
  KapEventPayload,
  RunEvent,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from '@poietica/agent-contract'
import { isTerminal, type ToolCallTimelineItem } from './timeline-contract'
import type { Draft } from './timeline-draft'
import { appendChunk, namespace, positionOf, push } from './timeline-draft'

/** 这条线上的方言帧。其余每一格两条线共用，归 projection。 */
export type KapFrame = Extract<RunEvent, { kind: 'kap_event' }>

/** 一次工具调用的某一帧真的带了的格子。缺席表示这一帧没提，不是没有。 */
interface ToolCallPatch {
  readonly title?: string
  readonly kind?: ToolKind
  readonly subject?: string
  readonly isBackground?: true
  readonly status?: ToolCallStatus
  readonly content?: readonly ToolCallContent[]
  readonly appendContent?: ToolCallContent
  readonly locations?: readonly ToolCallLocation[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
}

export function applyKapFrame(draft: Draft, event: KapFrame): void {
  const payload = event.payload
  const scope = namespace(draft)

  switch (payload.type) {
    case 'assistant.delta': {
      const delta = stringOf(payload, 'delta')

      if (delta === undefined) {
        return
      }

      /* kap 的文本增量不带消息号（只有 turnId），边界退回相邻续写 ——
         appendChunk 在身份缺席时的原行为。 */
      appendChunk(draft, 'agent_text', {
        at: event.at,
        id: `${scope}text-${String(event.seq)}`,
        text: delta,
      })

      return
    }

    case 'thinking.delta': {
      const delta = stringOf(payload, 'delta')

      if (delta === undefined) {
        return
      }

      appendChunk(draft, 'agent_thought', {
        at: event.at,
        id: `${scope}thought-${String(event.seq)}`,
        text: delta,
      })

      return
    }

    case 'tool.call.delta': {
      /* 入参的流片：卡先立起来，半个 JSON 没有读者。解析好的 args 整体随
         tool.call.started 到齐（events-zod.ts：delta 带 argumentsPart 片段，
         started 带 args 整体）。 */
      const toolCallId = stringOf(payload, 'toolCallId')

      if (toolCallId === undefined) {
        return
      }

      const name = stringOf(payload, 'name')

      upsertToolCall(draft, toolCallId, event.at, {
        status: 'in_progress',
        ...(name === undefined ? {} : { title: name }),
      })

      return
    }

    case 'tool.call.started': {
      const toolCallId = stringOf(payload, 'toolCallId')

      if (toolCallId === undefined) {
        return
      }

      const name = stringOf(payload, 'name')

      const shown = fromDisplay(fieldOf(payload, 'display'))
      const said = stringOf(payload, 'description')

      upsertToolCall(draft, toolCallId, event.at, {
        status: 'in_progress',
        rawInput: fieldOf(payload, 'args'),
        ...(name === undefined ? {} : { title: name }),
        ...shown,
        ...(shown.subject === undefined && said !== undefined ? { subject: said } : {}),
      })

      return
    }

    case 'tool.progress': {
      /* 进度是追加，不是替换：每一帧都是产出的下一截。percent 之类的仪表在
         这张卡片上没有读者，不落。 */
      const toolCallId = stringOf(payload, 'toolCallId')
      const update = fieldOf(payload, 'update')
      const text =
        typeof update === 'object' && update !== null ? Reflect.get(update, 'text') : undefined

      if (toolCallId === undefined || typeof text !== 'string' || text === '') {
        return
      }

      upsertToolCall(draft, toolCallId, event.at, {
        status: 'in_progress',
        appendContent: { type: 'content', content: { type: 'text', text } },
      })

      return
    }

    case 'tool.result': {
      const toolCallId = stringOf(payload, 'toolCallId')

      if (toolCallId === undefined) {
        return
      }

      upsertToolCall(draft, toolCallId, event.at, {
        status: fieldOf(payload, 'isError') === true ? 'failed' : 'completed',
        rawOutput: fieldOf(payload, 'output'),
      })

      return
    }

    case 'error': {
      /* agent 自己的说法逐字进转录：一轮因额度或鉴权死掉时，这句话是屏幕上
         唯一的交代。code 是它的名字，一起留。 */
      const message = stringOf(payload, 'message')

      if (message === undefined) {
        return
      }

      const code = stringOf(payload, 'code')

      push(draft, {
        type: 'error',
        id: `${scope}error-${String(event.seq)}`,
        turn: draft.runIndex,
        at: event.at,
        message: code === undefined ? message : `${code}: ${message}`,
      })

      return
    }

    case 'turn.started':
    case 'turn.ended': {
      /* 轮次起止的唯一权威是 projection.ts 的 run_started / run_finished
         （原生侧正是从这两个 kap 事件合成的它们）。这里落账就是同一件事
         记两遍。 */
      return
    }

    case 'agent.status.updated': {
      /* volatile 的仪表信号：driver 已把它单独转给 SessionEvent::Usage。
         转录记事实，不是仪表盘。 */
      return
    }

    case 'prompt.submitted': {
      /* 那一问由 run_started 带全（projection.ts 的 withPrompt 是唯一落账处）。 */
      return
    }

    case 'warning': {
      /* 界面没有 warning 这一档，够不上 error 条目的不进转录。 */
      return
    }

    default: {
      /* 认得的才落，是这张映射的边界：任务、子代理、压缩、技能、MCP 那几十种
         事件默认不落账。真要显示它们的那天，在这里加一支，而不是在别处开一
         个口子。 */
      return
    }
  }
}

/**
 * 载荷里的一个格子。
 *
 * 键走变量而不是字面量，是被两条规矩夹出来的：载荷的形状是一条索引签名（契约
 * 那一层不为它不认识的字段写名字），于是 noPropertyAccessFromIndexSignature 不
 * 许写 payload.args，而 biome 的 useLiteralKeys 不许写 payload['args']。取一个
 * 名字进来，两条都不再适用。
 *
 * 顺带把这件事说清楚了：这不是在读一个已知的属性，是在一份形状未经校验的载荷里
 * 挑一格 —— 返回 unknown，认它是什么由调用处自己判。
 */
function fieldOf(payload: KapEventPayload, key: string): unknown {
  return payload[key]
}

/** 载荷里的一个字符串格子：不是非空字符串就当它没带。 */
function stringOf(payload: KapEventPayload, key: string): string | undefined {
  const value = fieldOf(payload, key)

  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 一次工具调用的投影，只有这一条路径。
 *
 * delta / started / progress / result 是同一次调用的四次到达，协议按
 * toolCallId 寻址：没见过就建（终帧先于宣告到达的日志存在），见过就按这
 * 一帧真的带了的格子合并 —— 一个 upsert，不是四份实现。
 *
 * endedAt：终态才记，记下就不再移动。终态的判据归 timeline-contract —— 状态
 * 词汇是产品模型的，不是方言。
 */
function upsertToolCall(draft: Draft, toolCallId: string, at: number, patch: ToolCallPatch): void {
  const id = `${namespace(draft)}tool-${toolCallId}`
  const position = positionOf(draft, id)
  const found = position < 0 ? undefined : draft.items[position]
  const held = found?.type === 'tool_call' ? found : undefined

  const status = patch.status ?? held?.status ?? 'in_progress'
  const endedAt = isTerminal(status) ? (held?.endedAt ?? at) : held?.endedAt
  const base = patch.content ?? held?.content ?? []
  const content = patch.appendContent === undefined ? base : [...base, patch.appendContent]
  /* 'rawInput' in patch 读的是「这一帧提没提」：null 是清空，缺席是沿用。 */
  const rawInput = 'rawInput' in patch ? patch.rawInput : held?.rawInput
  const rawOutput = 'rawOutput' in patch ? patch.rawOutput : held?.rawOutput

  const next: ToolCallTimelineItem = {
    type: 'tool_call',
    id,
    /* 一次调用属于它开始的那一段；起点记下就不再移动。 */
    turn: held?.turn ?? draft.runIndex,
    at: held?.at ?? at,
    toolCallId,
    title: patch.title ?? held?.title ?? toolCallId,
    kind: patch.kind ?? held?.kind ?? 'other',
    subject: patch.subject ?? held?.subject ?? '',
    status,
    content,
    locations: patch.locations ?? held?.locations ?? [],
    startedAt: held?.startedAt ?? at,
    ...((patch.isBackground ?? held?.isBackground) ? { isBackground: true } : {}),
    ...(rawInput === undefined ? {} : { rawInput }),
    ...(rawOutput === undefined ? {} : { rawOutput }),
    ...(endedAt === undefined ? {} : { endedAt }),
  }

  if (held === undefined) {
    push(draft, next)
  } else {
    draft.items[position] = next
  }
}

/** display 里的一个字符串格子。 */
function textOf(display: object, key: string): string {
  const value = Reflect.get(display, key)

  return typeof value === 'string' ? value : ''
}

/** 这次写进去的是什么：before/after/content 三格由 kap 直接给。 */
function writtenOf(display: object): { readonly content?: readonly ToolCallContent[] } {
  const path = textOf(display, 'path')
  const after = Reflect.get(display, 'after')
  const held = typeof after === 'string' ? after : Reflect.get(display, 'content')
  const before = Reflect.get(display, 'before')

  if (path === '' || typeof held !== 'string') {
    return {}
  }

  return {
    content: [
      {
        type: 'diff',
        path,
        newText: held,
        ...(typeof before === 'string' ? { oldText: before } : {}),
      },
    ],
  }
}

/** file_io 的五种操作各自落哪一档；上游长出第六种时落回 other。 */
function fromFileIo(display: object): ToolCallPatch {
  const path = textOf(display, 'path')
  const at = path === '' ? {} : { locations: [{ path }] }
  const said = { subject: path, ...at }

  switch (Reflect.get(display, 'operation')) {
    case 'read': {
      return { kind: 'read', ...said }
    }
    case 'write': {
      return { kind: 'write', ...said }
    }
    case 'edit': {
      return { kind: 'edit', ...said }
    }
    case 'glob':
    case 'grep': {
      return { kind: 'search', ...said }
    }
    default: {
      return { kind: 'other', ...said }
    }
  }
}

/**
 * kap 的显示提示（events-zod.ts 的 ToolInputDisplaySchema，十三档）往产品模型的
 * 四格上映：kind、subject、locations、content。
 *
 * 分类的权威是 display，不是工具名 —— 工具名随版本改，display 由工具自己声明
 * （agent-core-v2 的 toolContract.ts：RunnableToolExecution.display）。停止任务
 * 归到 task：读者眼里它们是同一条后台线。提示缺席时不猜，退回派发自己写的那一句。
 */
function fromDisplay(display: unknown): ToolCallPatch {
  if (typeof display !== 'object' || display === null) {
    return {}
  }

  switch (Reflect.get(display, 'kind')) {
    case 'command': {
      return { kind: 'execute', subject: textOf(display, 'command') }
    }

    case 'file_io': {
      return { ...fromFileIo(display), ...writtenOf(display) }
    }

    case 'diff': {
      const path = textOf(display, 'path')

      return { kind: 'edit', subject: path, locations: [{ path }], ...writtenOf(display) }
    }

    case 'search': {
      return { kind: 'search', subject: textOf(display, 'query') }
    }

    case 'url_fetch': {
      return { kind: 'fetch', subject: textOf(display, 'url') }
    }

    case 'agent_call': {
      return {
        kind: 'delegate',
        subject: textOf(display, 'prompt'),
        ...(Reflect.get(display, 'background') === true ? { isBackground: true } : {}),
      }
    }

    case 'skill_call': {
      const name = textOf(display, 'skill_name')
      const args = textOf(display, 'args')

      return { kind: 'skill', subject: args === '' ? name : `${name} ${args}` }
    }

    case 'todo_list': {
      return { kind: 'todo' }
    }

    case 'task': {
      return { kind: 'task', subject: textOf(display, 'description') }
    }

    case 'task_stop': {
      return { kind: 'task', subject: textOf(display, 'task_description') }
    }

    case 'plan_review': {
      return { kind: 'plan', subject: textOf(display, 'plan') }
    }

    case 'goal_start': {
      return { kind: 'goal', subject: textOf(display, 'objective') }
    }

    case 'generic': {
      return { kind: 'other', subject: textOf(display, 'summary') }
    }

    default: {
      return {}
    }
  }
}
