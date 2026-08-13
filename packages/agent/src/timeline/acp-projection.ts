/**
 * 协议方言到条目的投影。
 *
 * 这是唯一认识 ACP 的地方：帧有哪些种类、chunk 的边界怎么定、tool_call 与
 * tool_call_update 如何合成一次 upsert、stopReason 怎么读成一个结局 —— 全部
 * 收在这个文件里，别处不该再出现一个 Acp 前缀。
 *
 * 它只往草稿上写，既不开草稿也不封版（见 timeline-draft），所以「纯、总、可
 * 重放」那三条性质与它无关：那是入口那一层的承诺。
 */

import type {
  AcpContentBlock,
  AcpSessionUpdate,
  AcpStopReason,
  AcpToolCallContent,
  AcpToolCallUpdate,
  RunEvent,
  RunStatus,
} from '@poietica/agent-contract'
import { isRenderable } from './renderable'
import type {
  AgentTextItem,
  AgentThoughtItem,
  ToolCallTimelineItem,
  UserMessageItem,
} from './timeline-contract'
import type { Draft } from './timeline-draft'
import {
  beginQuestion,
  markTurnEnd,
  markTurnStart,
  namespace,
  positionOf,
  push,
  sealTail,
} from './timeline-draft'
import { pendingPermission } from './timeline-queries'

/**
 * 这一帧一定会被丢掉吗。
 *
 * 这不是一道闸门，是一次保守的预判：为真时 apply 一定丢，为假时什么都不承诺。
 * 它唯一的作用是让一整批全是重复帧的输入不必开草稿 —— 引用原样交回，下游的记忆
 * 化不会被白白打掉。真正的去重只有 apply 里那一处，就在下面。
 *
 * run_started 不预判：它开的那一段窗口马上要重来（beginRun），拿上一段的窗口去
 * 判它，判出来的重复是假的。
 *
 * 它住在这里而不住在调用方，是因为它逼近的那条判据在这里 —— 一份权威，一份贴着
 * 权威写的近似，中间没有可以各自漂移的余地。
 */
export function surelyIgnored(event: RunEvent, lastSeq: number): boolean {
  return event.kind !== 'run_started' && event.seq <= lastSeq
}

export function apply(draft: Draft, event: RunEvent): void {
  /*
   * 段的边界不在这里判。
   *
   * 一帧 run_started 可能是新的一轮，也可能是同一份日志被重放了一遍，而这两者的
   * seq、at、prompt 全都一样：apply 手上没有任何东西能把它们分开。所以由知道自己
   * 在干什么的那一层来开段 —— 人先说话时是 appendUserMessage，没有经过输入框的那
   * 些轮次是 beginRun，而 replayRunEvents 一轮到底、一段都不开：同一份日志放两遍
   * 必须得到同一个状态，这是回放能被信任的前提。
   *
   * 去重只有下面这一处。正因为一段都不开的那条路径上没有第二张网，这里不能跟着
   * surelyIgnored 一起给 run_started 放行 —— 放行之后紧跟着的那句赋值会把窗口拨
   * 回到它的 seq，后面每一帧都会重新生效一遍。
   */
  if (event.seq <= draft.lastSeq) {
    return
  }

  draft.lastSeq = event.seq

  switch (event.kind) {
    case 'run_started': {
      draft.status = 'running'
      /* 起点是这一帧的时刻，不是本机此刻：回放要复现同一个耗时。 */
      markTurnStart(draft, event.at)
      withPrompt(draft, event)

      return
    }

    case 'acp_update': {
      applyAcpUpdate(draft, event.notification.update, event.seq, event.at)

      return
    }

    case 'permission_requested': {
      draft.status = 'awaiting_permission'

      /* 请求随身带的那一份多半只有一个 toolCallId，入参在宣告那一帧里。 */
      const asked = askedAbout(draft, event.toolCallId, event.toolCall)

      push(draft, {
        type: 'permission',
        id: `${namespace(draft)}permission-${event.requestId}`,
        turn: draft.runIndex,
        at: event.at,
        requestId: event.requestId,
        title: event.title,
        /* 缺席和"值为 undefined"在 exactOptionalPropertyTypes 下不是一回事，
           所以没带就整个键不写。 */
        ...(asked === undefined ? {} : { toolCall: asked }),
        options: event.options,
      })

      return
    }

    case 'permission_resolved': {
      /* 身份是算得出来的（见 permission_requested 那一支），所以按 id 定位。
         此前每来一次答复就把整条转录扫一遍 —— 索引就在同一个文件里。 */
      const position = positionOf(draft, `${namespace(draft)}permission-${event.requestId}`)
      const asked = position < 0 ? undefined : draft.items[position]

      if (asked?.type === 'permission') {
        draft.items[position] = {
          ...asked,
          resolution: { optionId: event.optionId, outcome: event.outcome },
        }
      }

      /* 答掉一个不等于不再等。并行的子代理会同时挂着几个请求（ADR 0002），
         此前这一支开头无条件写 running —— 第一个答复一到，状态就说这一轮不在
         等人了，而另外几个请求还挂在原生侧的桌子上，界面上再没有入口。
         这句话必须排在上面那次落账之后：刚答掉的这一个也在扫描范围里。 */
      draft.status = pendingPermission(draft) === undefined ? 'running' : 'awaiting_permission'

      return
    }

    case 'run_finished': {
      /* A turn can end on the agent terms and still be a failure: a rejected
         provider request is reported by the agent itself, outside the
         protocol, and the stop reason stays ordinary. When it left such an
         account, that account is the entry, and our own wording never
         appears at all. */
      sealTail(draft)
      /* 一轮的结局是一轮的事实，不是它发起的每一次调用的事实。没等到终态的
         调用就停在它最后被报到的地方：status 装的是协议值，也就是 agent 说过
         的话，这一层没有资格替它补一句「失败」。停住的纺锤怎么画，归读模型。 */
      draft.status = finalStatus(event.stopReason)
      markTurnEnd(draft, event.at)

      const said = event.diagnostics?.trim() ?? ''
      const told = said.length > 0 ? said : silentTurn(draft, event.stopReason)

      if (told !== undefined) {
        push(draft, {
          type: 'error',
          id: `${namespace(draft)}agent-${String(event.seq)}`,
          turn: draft.runIndex,
          at: event.at,
          message: told,
        })
      }

      return
    }

    case 'run_failed': {
      sealTail(draft)
      draft.status = 'failed'
      markTurnEnd(draft, event.at)
      push(draft, {
        type: 'error',
        id: `${namespace(draft)}error-${String(event.seq)}`,
        turn: draft.runIndex,
        at: event.at,
        message: preferAgent(event.message, event.diagnostics),
      })

      return
    }
  }
}

/*
 * 收窄后的协议更新类型。用 Extract 而不是在 contracts 里新导出七个成员名：
 * 判别式已经在类型里了，再手抄一份就是第二份需要同步维护的清单。
 */
type AcpUpdateOf<TKind extends AcpSessionUpdate['sessionUpdate']> = Extract<
  AcpSessionUpdate,
  { sessionUpdate: TKind }
>

function applyAcpUpdate(draft: Draft, update: AcpSessionUpdate, seq: number, at: number): void {
  const scope = namespace(draft)

  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      appendSaid(draft, scope, seq, at, saidByUser(textOf(update.content)))

      return
    }

    case 'agent_message_chunk': {
      appendChunk(draft, 'agent_text', update, scope, seq, at)

      return
    }

    case 'agent_thought_chunk': {
      appendChunk(draft, 'agent_thought', update, scope, seq, at)

      return
    }

    case 'tool_call':
    case 'tool_call_update': {
      upsertToolCall(draft, update, scope, at)

      return
    }

    case 'plan': {
      /* The protocol replaces the whole plan; keep exactly one plan entry per
         turn, so a later turn cannot rewrite an earlier one. */
      const id = `${scope}plan`
      const plan = { type: 'plan', id, turn: draft.runIndex, at, entries: update.entries } as const
      const position = positionOf(draft, id)

      if (position < 0) {
        push(draft, plan)

        return
      }

      draft.items[position] = plan

      return
    }

    case 'available_commands_update': {
      /* A session capability, not a turn. The command list belongs to the
         composer that offers the commands, not to the transcript of what
         happened, so it produces no item here. This case is written out rather
         than left to the default so that ignoring it stays a decision. */
      return
    }

    case 'usage_update': {
      /* 会话的状态，不是一轮的内容：用量走原生侧的会话状态通道
         （ai-usage-report），由 SessionControlsStore 持有唯一一份。多数时候它
         在轮外到达、根本进不了帧流；万一 agent 在轮内也推一份，这里明说不落
         转录 —— 与上一格同一条规矩，忽略也要是一个决定。 */
      return
    }
  }
}

/**
 * 一次工具调用的投影，只有这一条路径。
 *
 * tool_call 与 tool_call_update 是同一件事的两次到达：协议按 toolCallId 寻址，
 * 两种帧携带同一组字段，区别只在后者全部可选。所以没见过就建，见过就按这一帧
 * 真的带了的字段合并 —— 一个 upsert，不是两份实现。
 *
 * 此前是两个函数，而且不等价：tool_call 分支整份覆盖，于是 agent 依协议重发一次
 * tool_call 会把已经收到的 endedAt 与 rawOutput 一并抹掉。
 *
 * 也不再把旧的 diff 往新 content 前面拼。协议规定 content 是整体替换，拼接是
 * 客户端自己发明的语义：对只在中途带一次 diff 的 agent，它会让同一次调用显示
 * 两份 diff。要显示什么由帧说了算，这一层不猜。
 */
function upsertToolCall(
  draft: Draft,
  update: AcpUpdateOf<'tool_call'> | AcpUpdateOf<'tool_call_update'>,
  scope: string,
  at: number,
): void {
  const id = `${scope}tool-${update.toolCallId}`
  const position = positionOf(draft, id)
  const found = position < 0 ? undefined : draft.items[position]
  const held = found?.type === 'tool_call' ? found : undefined

  /* 合并规则整段搬进 mergedFacts：仍然只有那一处，只是不再算进这个函数的认知
     复杂度（biome 的 noExcessiveCognitiveComplexity）。下面每一格照旧读它。 */
  const { content, endedAt, rawInput, rawOutput, status } = mergedFacts(held, update, at)

  const next: ToolCallTimelineItem = {
    type: 'tool_call',
    id,
    /* 一次调用属于它开始的那一段，与 at 同一条规矩：记下就不再移动。 */
    turn: held?.turn ?? draft.runIndex,
    at: held?.at ?? at,
    toolCallId: update.toolCallId,
    title: update.title ?? held?.title ?? update.toolCallId,
    kind: update.kind ?? held?.kind ?? 'other',
    status,
    content,
    locations: update.locations ?? held?.locations ?? [],
    startedAt: held?.startedAt ?? at,
    ...(rawInput === undefined ? {} : { rawInput }),
    ...(rawOutput === undefined ? {} : { rawOutput }),
    ...(endedAt === undefined ? {} : { endedAt }),
  }

  if (held === undefined) {
    push(draft, next)
  } else {
    draft.items[position] = next
  }

  /* 宣告晚于请求时，把入参补回那条还在等的请求。 */
  relink(draft, next)
}

/**
 * 一次调用里会变的那几格：这一帧真的带了就听它的，没带就沿用手上那一份。
 *
 * 单独成函数不是为了复用 —— 调用方只有 upsertToolCall 一个。判据一个字没改：
 * status 三级回退、终态才记 endedAt 且记下不再移动、rawInput/rawOutput 用 in 判
 * 「这一帧提没提」、content 整体替换而不是拼接。
 */
type ToolCallFacts = {
  readonly content: readonly AcpToolCallContent[]
  readonly endedAt: number | undefined
  readonly rawInput: unknown
  readonly rawOutput: unknown
  readonly status: ToolCallTimelineItem['status']
}

function mergedFacts(
  held: ToolCallTimelineItem | undefined,
  update: AcpUpdateOf<'tool_call'> | AcpUpdateOf<'tool_call_update'>,
  at: number,
): ToolCallFacts {
  const status = update.status ?? held?.status ?? 'pending'
  /* running 的调用没有结束时间，这与「有一个 undefined 的结束时间」不是一回事；
     结束一旦记下就不再移动。 */
  const endedAt = isTerminal(status) ? (held?.endedAt ?? at) : held?.endedAt
  const rawInput = 'rawInput' in update ? update.rawInput : held?.rawInput
  const rawOutput = 'rawOutput' in update ? update.rawOutput : held?.rawOutput
  /* 协议里 null 是「清空」、undefined 是「这一帧没提」。这里保持本文件原有的读法
     （两者都退回已有内容），这次改动不顺手改它的语义。 */
  const said = update.content ?? undefined
  const content =
    said === undefined ? (held?.content ?? []) : withoutArgumentEcho(said, rawInput, status)

  return { content, endedAt, rawInput, rawOutput, status }
}

/**
 * 被征求同意的那次调用，补上它没带的入参。
 *
 * 协议把一次调用与一次授权请求分成两帧：宣告那一帧（session/update 的 tool_call）
 * 带完整的 rawInput，请求那一帧（session/request_permission）带的 ToolCallUpdate
 * 除 toolCallId 之外全部可选，而多数 agent 在这里只带一个号 —— 原生侧为此专门养了
 * 一张标题退路表（recorder.rs 的 permission_title），那就是这件事的现场证词。
 *
 * 两帧说的是同一次调用，协议本来就是按号寻址的，所以按号把它们合起来 —— 与
 * upsertToolCall 合并 tool_call 与 tool_call_update 是同一件事，不是发明语义。
 *
 * 只补 rawInput。它是「要批准的到底是哪一条命令」的唯一载体，也是唯一能原样转交、
 * 不必重新构造任何协议类型的那一格：content 与 locations 在条目上是只读的。
 *
 * 请求自己带了入参时以它为准：人要签字的是真正发出去的那一份。
 */
function askedAbout(
  draft: Draft,
  toolCallId: string | undefined,
  carried: AcpToolCallUpdate | undefined,
): AcpToolCallUpdate | undefined {
  if (carried === undefined || carried.rawInput !== undefined || toolCallId === undefined) {
    return carried
  }

  const position = positionOf(draft, `${namespace(draft)}tool-${toolCallId}`)
  const found = position < 0 ? undefined : draft.items[position]
  const rawInput = found?.type === 'tool_call' ? found.rawInput : undefined

  return rawInput === undefined ? carried : { ...carried, rawInput }
}

/**
 * 宣告晚于请求的那一半。
 *
 * 反过来的顺序协议同样允许：agent 可以先问「许不许」，再把这次调用报上来。那时
 * 上面那次合并手上还没有东西，所以入参真的到达时在这里补回去 —— 一件事两个到达
 * 顺序，只补一头等于只有一半的人能看见那条命令。
 *
 * 只在真的有人在等的时候扫。状态由帧逐帧维护（timeline-queries 里是同一条判据），
 * 所以流式期间这一句就是一次相等比较，倒扫挂不到热路径上。
 */
function relink(draft: Draft, call: ToolCallTimelineItem): void {
  if (draft.status !== 'awaiting_permission' || call.rawInput === undefined) {
    return
  }

  for (let index = draft.items.length - 1; index >= 0; index -= 1) {
    const item = draft.items[index]

    if (item === undefined) {
      continue
    }

    /* 段边界收手：别的段里那些请求早就不在原生侧的桌子上了。 */
    if (item.turn !== draft.runIndex) {
      return
    }

    if (item.type !== 'permission' || item.resolution !== undefined) {
      continue
    }

    const carried = item.toolCall

    if (
      carried === undefined ||
      carried.toolCallId !== call.toolCallId ||
      carried.rawInput !== undefined
    ) {
      continue
    }

    draft.items[index] = { ...item, toolCall: { ...carried, rawInput: call.rawInput } }
  }
}
/*
 * 一份入参只被字符串化一次。
 *
 * withoutArgumentEcho 挂在流式热路径上：一次工具调用的每一帧 tool_call_update 只要
 * 带了 content 且还没终态，就会走到这里要一次入参的 JSON。而入参在整次调用里通常一
 * 个字都不变 —— 不带 rawInput 的帧继承的是同一个对象引用（见 upsertToolCall）。于是
 * 此前每帧把整份入参序列化一遍，写文件那类调用的入参装着整篇文件内容：几十 KB 的
 * 序列化，每秒六十次，每次得到逐字相同的字符串。
 *
 * 按对象弱引用记住，命中判据就是身份本身，不是一次深比较 —— 那会把要省的活儿又干
 * 一遍。带来新入参的那一帧换一个新对象，于是它照常重算：该算的一次不少，不该算的
 * 一次不多。表随入参对象一起被回收。
 */
const ENCODED = new WeakMap<object, string | null>()

/**
 * 一次调用的入参，按上游的写法字符串化。
 *
 * 上游用的是 JSON.stringify(args)（kimi-code 的 events-map.ts:stringifyArgs），而
 * rawInput 就是同一份 args 解析回来的对象 —— JSON 往返保留键序，所以两边算出来是
 * 同一个字符串。它那边 stringify 抛错时退回 String(args)，这里不跟：认不出就不认，
 * 宁可多留一段，不肯错藏一段真产出。
 */
function encode(value: unknown): string | null {
  /* 原始值没有身份可记，而它们的序列化本来就是常数代价。 */
  if (typeof value !== 'object' || value === null) {
    return stringify(value)
  }

  const held = ENCODED.get(value)

  /* null 是一个记下来的答案（认不出的入参），undefined 才是没记过。 */
  if (held !== undefined) {
    return held
  }

  const text = stringify(value)

  ENCODED.set(value, text)

  return text
}

function stringify(value: unknown): string | null {
  try {
    const text = JSON.stringify(value)

    return text === undefined ? null : text
  } catch {
    return null
  }
}

function isEcho(entry: AcpToolCallContent, echo: string): boolean {
  if (entry.type !== 'content') {
    return false
  }

  const block = entry.content

  return block.type === 'text' && block.text.length > 0 && echo.startsWith(block.text)
}

/**
 * 摘掉入参回显。
 *
 * 协议把这两件事分成两格，措辞是逐字的：content 是「Content produced by the tool
 * call」，rawInput 是「Raw input parameters sent to the tool」。而上游建卡时就把入参
 * 的 JSON 全文写进 content，流式期间还逐帧替换成累积的片段 —— 它自己的注释管这叫
 * degraded preview。那不是这次调用的产出，是我们已经拿在手里的 rawInput 的一份降级
 * 重复：留着它，「这次调用产出了什么」这个问题在整个读模型里就永远得不到直答。
 *
 * 判据是「它是入参字符串化结果的前缀」，所以流到一半的未闭合片段一样认得出。终态
 * 之后不再摘：那时 content 已被结果帧整份替换，一个把入参回显成输出的工具，那段文
 * 本是真的产出。终态的判据借 isTerminal，本文件里只有那一份。
 *
 * 这与上面 upsertToolCall 里那句「要显示什么由帧说了算，这一层不猜」不冲突：那句话
 * 反对的是发明语义（把旧 diff 往新 content 前面拼），这里做的是一次可判定的相等比较。
 * 而且帧原样留在事件日志里 —— 事实来源没有被改写，判错了可以重放回来。
 *
 * 什么都没摘就交回原来那个数组：引用稳定是下游记忆化的前提。
 */
export function withoutArgumentEcho(
  content: readonly AcpToolCallContent[],
  rawInput: unknown,
  status: ToolCallTimelineItem['status'],
): readonly AcpToolCallContent[] {
  if (rawInput === undefined || isTerminal(status)) {
    return content
  }

  const echo = encode(rawInput)

  if (echo === null) {
    return content
  }

  const kept = content.filter((entry) => !isEcho(entry, echo))

  return kept.length === content.length ? content : kept
}

/**
 * 日志里录下的那一问。
 *
 * 人经输入框提交的那些轮次由 appendUserMessage 先开段先落账（它带得出图片，
 * 这一格带不出）；没经过输入框的那些轮次（自动化、重连续接）由这里落。
 *
 * 判据是「本段末尾已经是一问」，不是文本相等：同一句话在两轮里说两遍是常事，
 * 而两轮不会是同一段。段边界读的是条目自己的段号，与 relink、silentTurn 同一
 * 条 —— 这个文件里只有这一种边界写法。
 */
function withPrompt(
  draft: Draft,
  event: { readonly seq: number; readonly at: number; readonly prompt?: string | undefined },
): void {
  /* 缺席与空串在这里是同一件事：都表示这一帧没有带来一句要显示的话。 */
  const prompt = saidByUser(event.prompt ?? '')

  if (prompt.length === 0 || saidAtTail(draft)) {
    return
  }

  beginQuestion(draft)

  push(draft, {
    type: 'user_message',
    id: `${namespace(draft)}said-${String(event.seq)}`,
    turn: draft.runIndex,
    at: event.at,
    text: prompt,
  })
}

/** 本段末尾那一条是不是一问。O(1)，因为一问永远是它自己那一段的开头。 */
function saidAtTail(draft: Draft): boolean {
  const tail = draft.items.at(-1)

  return tail?.type === 'user_message' && tail.turn === draft.runIndex
}

/**
 * 把一段流式文本并进它所属的那一条消息。
 *
 * 边界此前是遍历顺序的副产品：末尾那条同类型、还没封口，就接着往上贴，而任何
 * 别的条目进来都会先给它封口。除此之外没有第二个信号 —— 所以 agent 背靠背发
 * 两条消息、中间什么都没插时，两条会粘成一条。
 *
 * 协议给了信号：ContentChunk 带 messageId，同一条消息的每一段带同一个号。
 * 号变了就是另一条消息，哪怕它紧挨着上一段。
 *
 * 它只会切，不会合。中间隔着一张工具卡片的两段，即使同号也仍然是两条：时间轴
 * 记的是发生的顺序，为了让同号的两段并拢而跨过中间那张卡片，就是在改写这个
 * 顺序。
 *
 * 号缺席时退回相邻续写，逐字保持原行为。这不是兼容层：messageId 在 schema 里
 * 本来就是可选的，client 必须能处理它不在的情况，而实现上也只是同一个条件里
 * 多一个合取项，没有第二条代码路径。
 */
function appendChunk(
  draft: Draft,
  type: 'agent_text' | 'agent_thought',
  update: AcpUpdateOf<'agent_message_chunk'> | AcpUpdateOf<'agent_thought_chunk'>,
  scope: string,
  seq: number,
  at: number,
): void {
  const chunk = textOf(update.content)
  /* 协议里「没报」是 undefined、「报了个空」是 null，对边界是同一件事；
     归一在这里做一次，模型里就只有「有号」和「没号」。 */
  const messageId = update.messageId ?? undefined
  const tail = draft.items.at(-1)

  if (tail && tail.type === type && !tail.sealed && sameMessage(tail, messageId)) {
    const grown: AgentTextItem | AgentThoughtItem = { ...tail, text: tail.text + chunk }

    draft.items[draft.items.length - 1] = grown

    return
  }

  const prefix = type === 'agent_text' ? 'text-' : 'thought-'

  push(draft, {
    type,
    id: scope + prefix + String(seq),
    turn: draft.runIndex,
    at,
    text: chunk,
    sealed: false,
    /* 缺席和「值为 undefined」在 exactOptionalPropertyTypes 下不是一回事。 */
    ...(messageId === undefined ? {} : { messageId }),
  } as AgentTextItem | AgentThoughtItem)
}

/**
 * 用户说的那一句，由若干块拼成。
 *
 * 协议发的是 chunk：一句话里的每一个 content block 各来一帧 —— 文字一帧，每张
 * 图各一帧。连着来的并成一条，与 agent 那半边（appendChunk）同一条规矩。
 *
 * 只看末尾那一条，因为一句话的各个块本来就连着到。末尾是本路径铸的，就接着写；
 * 末尾是别的路径刚在这一段落下的那一问（appendUserMessage 的 local-said-、日志
 * 里的 said-），这一帧就是它的回声 —— 那两份是人真正敲下的字节，协议这一份还
 * 夹着 agent 注入的旁白，所以以先到的为准。
 *
 * 判据只有身份与段号，没有一次文本比较：同一句话在两轮里说两遍时，比文本会把
 * 第二条判成重复丢掉，而附件按「第几条用户消息」挂回原处、缩略导航按「问过几
 * 次」数格子，少一条会让两处一起错。
 */
function appendSaid(draft: Draft, scope: string, seq: number, at: number, chunk: string): void {
  const tail = draft.items.at(-1)

  if (tail?.type === 'user_message' && tail.turn === draft.runIndex) {
    /* 本路径铸的那一条：同一句话的下一个内容块。图片那一帧交回空串（textOf 对
       image block 如此），它不带来新的字，但仍然属于这一问。 */
    if (chunk.length > 0 && tail.id.startsWith(`${scope}user-`)) {
      const grown: UserMessageItem = { ...tail, text: tail.text + chunk }

      draft.items[draft.items.length - 1] = grown
    }

    return
  }

  beginQuestion(draft)

  push(draft, {
    type: 'user_message',
    /* 段可能刚在上一句换过，所以前缀重新取一次：入口那次取的是上一段的。 */
    id: `${namespace(draft)}user-${String(seq)}`,
    turn: draft.runIndex,
    at,
    text: chunk,
  })
}

/** 号缺席时不表态，退回相邻续写；号在，就必须是同一个号。 */
function sameMessage(
  tail: AgentTextItem | AgentThoughtItem,
  messageId: string | undefined,
): boolean {
  return messageId === undefined || messageId === tail.messageId
}

/**
 * 用户这一句里，哪些字是用户自己说的。
 *
 * agent CLI 会往这一轮的用户消息里注入自己的旁白 —— 观察到的一例：只发了一
 * 张图，回放出来却是「一张图 + 一段 <system-reminder>，告诉模型这张图被压过、
 * 原图在哪个路径」。那段字不是人说的，把它当成人说的话显示出来，转录就在撒谎。
 *
 * 剥的是标记之间的整块，不是按关键词猜。标记是成对的，非贪婪地一块块吃掉，
 * 跨行也吃 —— 那段旁白本来就是多行的。
 *
 * 剥完为空时这条消息仍然留着，绝不能连气泡一起丢：一句纯图片的话，屏幕上正
 * 是靠这一格站住的，附件按第几条用户消息挂回来（见 attachImages）。少一格，
 * 两侧的数就不等，整批图一张都挂不上 —— 这不是假设，是这一条改动之前的现状。
 */
const INJECTED = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function saidByUser(text: string): string {
  return text.replace(INJECTED, '').trim()
}

/**
 * 这次调用已经有结局了吗。
 *
 * ACP 的四档 status 里只有 completed 与 failed 是终态。这里是这句话的唯一权威：
 * 它是对协议值的解读，而按本文件的头注释，这里就是唯一认识 ACP 的地方。
 * endedAt 记不记、纺锤转不转，读的必须是同一份判据。
 */
export function isTerminal(status: ToolCallTimelineItem['status']): boolean {
  return status === 'completed' || status === 'failed'
}

function textOf(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/**
 * 两份说法，都留下。
 *
 * message 是运行时报的（连接断了、进程没了），diagnostics 是 agent 自己说的
 * （Authentication required、配额用尽）。此前有后者时就把前者丢掉 —— 而排查
 * 一次失败要的恰好是两者的关系。重复的不写两遍，不重复的一句不删。
 */
function preferAgent(message: string, diagnostics?: string): string {
  const said = diagnostics?.trim() ?? ''
  const ours = message.trim()

  if (said.length === 0) {
    return message
  }

  return ours.length === 0 || said.includes(ours) ? said : `${message}\n${said}`
}

/**
 * 一轮结束，却一个字都没有。
 *
 * 这是一个事实，不是一句话：自这一轮的提问以来，转录里没有任何可看的条目。
 * 空转必须被说出来 —— 界面沉默等于把「我到底发出去了吗」丢给人自己猜。
 *
 * 但说出来的只能是协议自己的词：stopReason 的原值。此前这件事由派生层凭一个
 * 状态枚举编一句话来报，那句话里没有多一个字的事实，却占掉了唯一那一行。
 * 措辞该删，事实不该跟着一起删。
 *
 * agent 自己留下了 diagnostics 时根本走不到这里：一件事只有一个说法。
 *
 * 判据向后扫到本段边界为止，代价是一轮的长度，不是整条对话的长度；
 * isRenderable 与派生共用同一份 —— 抄第二份就会有两种「空」。
 *
 * 边界读的是条目自己的段号，不再是「撞见一条用户消息就算到头」。那个启发式
 * 在人于轮次进行中又说一句时会当场收错口；段号是 run_started 划的，它不会。
 * 提问单独跳过：它是两段之间的边界，不是这一段的产出。
 */
function silentTurn(draft: Draft, stopReason: AcpStopReason): string | undefined {
  for (let index = draft.items.length - 1; index >= 0; index -= 1) {
    const item = draft.items[index]

    if (item === undefined) {
      continue
    }

    if (item.turn !== draft.runIndex) {
      break
    }

    if (item.type === 'user_message') {
      continue
    }

    if (isRenderable(item)) {
      return undefined
    }
  }

  return `stopReason: ${stopReason}`
}

function finalStatus(stopReason: AcpStopReason): RunStatus {
  if (stopReason === 'cancelled') {
    return 'cancelled'
  }

  if (stopReason === 'refusal') {
    return 'failed'
  }

  return 'completed'
}
