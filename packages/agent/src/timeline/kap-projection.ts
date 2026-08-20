/**
 * kap 方言到条目的投影。
 *
 * 唯一认识 kap 的地方：事件载荷里哪个字段叫什么、文本增量往哪条消息上拼、
 * 一次工具调用的四个生命周期事件怎么合成一次 upsert —— 全收在这一个文件里，
 * 别处不该再出现对 kap 字段名的引用。一轮的起止与审批归 projection.ts。
 *
 * 载荷形状的唯一权威是上游 kap-server 的 protocol/events-zod.ts（快照钉在
 * contracts/kap）。这里读的每一个字段都应该能在那份文件里找到。
 *
 * 三段各管一件事：帧分流（applyKapFrame）、帧读成补丁（toolPatch 与 fromDisplay）、
 * 补丁合进条目（upsertToolCall）。
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
  switch (event.payload.type) {
    case 'assistant.delta':
    case 'thinking.delta': {
      applyDelta(draft, event)

      return
    }

    case 'tool.call.delta':
    case 'tool.call.started':
    case 'tool.progress':
    case 'tool.result': {
      applyToolFrame(draft, event)

      return
    }

    case 'error': {
      applyError(draft, event)

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

/* 文本增量不带消息号（只有 turnId），边界退回相邻续写 —— appendChunk 在身份缺席
   时的原行为。两种增量同一支：分流的只有落哪一类条目。 */
function applyDelta(draft: Draft, event: KapFrame): void {
  const delta = stringOf(event.payload, 'delta')

  if (delta === undefined) {
    return
  }

  const thinking = event.payload.type === 'thinking.delta'

  appendChunk(draft, thinking ? 'agent_thought' : 'agent_text', {
    at: event.at,
    id: `${namespace(draft)}${thinking ? 'thought' : 'text'}-${String(event.seq)}`,
    text: delta,
  })
}

/* agent 自己的说法逐字进转录：一轮因额度或鉴权死掉时，这句话是屏幕上唯一的交代。
   code 是它的名字，一起留。 */
function applyError(draft: Draft, event: KapFrame): void {
  const message = stringOf(event.payload, 'message')

  if (message === undefined) {
    return
  }

  const code = stringOf(event.payload, 'code')

  push(draft, {
    type: 'error',
    id: `${namespace(draft)}error-${String(event.seq)}`,
    turn: draft.runIndex,
    at: event.at,
    message: code === undefined ? message : `${code}: ${message}`,
  })
}

/** 四次到达认同一个 toolCallId：认不出来这一帧就不落账。 */
function applyToolFrame(draft: Draft, event: KapFrame): void {
  const toolCallId = stringOf(event.payload, 'toolCallId')

  if (toolCallId === undefined) {
    return
  }

  const patch = toolPatch(event.payload)

  if (patch !== null) {
    upsertToolCall(draft, toolCallId, event.at, patch)
  }
}

/** 这一帧说了什么。null 表示这一帧没有可落账的内容。 */
function toolPatch(payload: KapEventPayload): ToolCallPatch | null {
  switch (payload.type) {
    case 'tool.call.delta': {
      /* 入参的流片：卡先立起来，半个 JSON 没有读者。解析好的 args 整体随
         tool.call.started 到齐（events-zod.ts：delta 带 argumentsPart 片段，
         started 带 args 整体）。 */
      return { status: 'in_progress', ...titleOf(payload) }
    }

    case 'tool.call.started': {
      return {
        status: 'in_progress',
        rawInput: fieldOf(payload, 'args'),
        ...titleOf(payload),
        ...fromDisplay(fieldOf(payload, 'display'), stringOf(payload, 'description')),
      }
    }

    case 'tool.progress': {
      /* 进度是追加，不是替换：每一帧都是产出的下一截。percent 之类的仪表在这张
         卡片上没有读者，不落。 */
      const text = progressOf(payload)

      if (text === undefined) {
        return null
      }

      return {
        status: 'in_progress',
        appendContent: { type: 'content', content: { type: 'text', text } },
      }
    }

    case 'tool.result': {
      return {
        status: fieldOf(payload, 'isError') === true ? 'failed' : 'completed',
        rawOutput: fieldOf(payload, 'output'),
      }
    }

    default: {
      return null
    }
  }
}

/** 工具名这一帧提了就更，没提就沿用 —— 缺席不是空。 */
function titleOf(payload: KapEventPayload): ToolCallPatch {
  const name = stringOf(payload, 'name')

  return name === undefined ? {} : { title: name }
}

/** 进度那一句；update 的 kind 与 percent 没有读者。 */
function progressOf(payload: KapEventPayload): string | undefined {
  const update = fieldOf(payload, 'update')

  if (typeof update !== 'object' || update === null) {
    return undefined
  }

  const text = Reflect.get(update, 'text')

  return typeof text === 'string' && text !== '' ? text : undefined
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
 */
function upsertToolCall(draft: Draft, toolCallId: string, at: number, patch: ToolCallPatch): void {
  const id = `${namespace(draft)}tool-${toolCallId}`
  const position = positionOf(draft, id)
  const found = position < 0 ? undefined : draft.items[position]
  const held = found?.type === 'tool_call' ? found : undefined

  const status = patch.status ?? held?.status ?? 'in_progress'

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
    content: contentOf(patch, held),
    locations: patch.locations ?? held?.locations ?? [],
    startedAt: held?.startedAt ?? at,
    ...tailOf(patch, held, status, at),
  }

  if (held === undefined) {
    push(draft, next)
  } else {
    draft.items[position] = next
  }
}

/** 进度是追加，整份内容是替换：这一帧带了哪一样就按哪一样合。 */
function contentOf(
  patch: ToolCallPatch,
  held: ToolCallTimelineItem | undefined,
): readonly ToolCallContent[] {
  const base = patch.content ?? held?.content ?? []

  return patch.appendContent === undefined ? base : [...base, patch.appendContent]
}

type ToolCallTail = Pick<
  ToolCallTimelineItem,
  'endedAt' | 'isBackground' | 'rawInput' | 'rawOutput'
>

/**
 * 缺席的格子不落键：exactOptionalPropertyTypes 下「没有这一格」与「这一格是
 * undefined」不是一件事。
 *
 * 'rawInput' in patch 读的是「这一帧提没提」：null 是清空，缺席是沿用。endedAt 终态
 * 才记，记下就不再移动（终态的判据归 timeline-contract —— 状态词汇是产品模型的，不是
 * 方言）。后台那一格只涨不落：一次后台派发不会中途回到前台。
 */
function tailOf(
  patch: ToolCallPatch,
  held: ToolCallTimelineItem | undefined,
  status: ToolCallStatus,
  at: number,
): ToolCallTail {
  const rawInput = 'rawInput' in patch ? patch.rawInput : held?.rawInput
  const rawOutput = 'rawOutput' in patch ? patch.rawOutput : held?.rawOutput
  const endedAt = isTerminal(status) ? (held?.endedAt ?? at) : held?.endedAt

  return {
    ...(rawInput === undefined ? {} : { rawInput }),
    ...(rawOutput === undefined ? {} : { rawOutput }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...((patch.isBackground ?? held?.isBackground) === true ? { isBackground: true } : {}),
  }
}

/** display 里的一个字符串格子。 */
function textOf(display: object, key: string): string {
  const value = Reflect.get(display, key)

  return typeof value === 'string' ? value : ''
}

/** 这次写进去的是什么：before/after/content 三格由 kap 直接给，不从入参里猜。 */
function writtenOf(display: object, path: string): ToolCallPatch {
  const after = Reflect.get(display, 'after')
  const body = typeof after === 'string' ? after : Reflect.get(display, 'content')

  if (path === '' || typeof body !== 'string') {
    return {}
  }

  const before = Reflect.get(display, 'before')

  return {
    content: [
      {
        type: 'diff',
        path,
        newText: body,
        ...(typeof before === 'string' ? { oldText: before } : {}),
      },
    ],
  }
}

/**
 * file_io 的五种操作分两类：读写一份文件，和按模式找东西。
 *
 * 写入的正文只在 write 与 edit 上合成 —— kap 的 file_io 允许 read 也带 content，
 * 拿它合出一份 diff 就是把一次「读」画成一次写入，diffStat 还会给它记新增行。
 *
 * glob / grep 的 path 是被搜的范围，不是被碰的文件，所以不进 locations：组卡那句
 * 「阅读 N 个文件」与抽屉里围栏的语言都读它。上游长出第六种操作时落 other。
 */
function fromFileIo(display: object): ToolCallPatch {
  const path = textOf(display, 'path')
  const at = path === '' ? {} : { locations: [{ path }] }

  switch (Reflect.get(display, 'operation')) {
    case 'read': {
      return { kind: 'read', subject: path, ...at }
    }

    case 'write': {
      return { kind: 'write', subject: path, ...at, ...writtenOf(display, path) }
    }

    case 'edit': {
      return { kind: 'edit', subject: path, ...at, ...writtenOf(display, path) }
    }

    case 'glob':
    case 'grep': {
      return { kind: 'search', subject: path }
    }

    default: {
      return { kind: 'other', subject: path }
    }
  }
}

/** diff 档：路径缺席时它只是一次编辑，凑不出一张 diff，也不占一个空路径。 */
function fromDiff(display: object): ToolCallPatch {
  const path = textOf(display, 'path')

  if (path === '') {
    return { kind: 'edit' }
  }

  return { kind: 'edit', subject: path, locations: [{ path }], ...writtenOf(display, path) }
}

/**
 * kap 的显示提示（events-zod.ts 的 ToolInputDisplaySchema，十三档）往产品模型的
 * 四格上映：kind、subject、locations、content。
 *
 * 分类的权威是 display，不是工具名 —— 工具名随版本改，display 由工具自己声明
 * （agent-core-v2 的 toolContract.ts：RunnableToolExecution.display），上游自己的
 * 客户端读的也是它。停止任务归到 task：读者眼里它们是同一条后台线。
 */
function fromDisplay(display: unknown, said: string | undefined): ToolCallPatch {
  const patch = fromShape(display)

  /* 一档都定不出来（提示缺席，或者上游长出了我们还不认识的那一档）才听派发自己写的
     那一句。定出了档就全信 display —— 两个来源各说一句是分类混乱的起点。 */
  if (patch.kind !== undefined || said === undefined) {
    return patch
  }

  return { subject: said }
}

function fromShape(display: unknown): ToolCallPatch {
  if (typeof display !== 'object' || display === null) {
    return {}
  }

  switch (Reflect.get(display, 'kind')) {
    case 'command': {
      return { kind: 'execute', subject: textOf(display, 'command') }
    }

    case 'file_io': {
      return fromFileIo(display)
    }

    case 'diff': {
      return fromDiff(display)
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
      /* args 是一份对象（display.ts 的 SkillCallDisplay），一行里画不下也没有读者：
         要看的人展开抽屉，完整入参在那里。技能名就是主语。 */
      return { kind: 'skill', subject: textOf(display, 'skill_name') }
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
