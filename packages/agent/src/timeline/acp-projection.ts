/**
 * 协议方言到条目的投影。
 *
 * 这是唯一认识 ACP 的地方：帧有哪些种类、chunk 的边界怎么定、tool_call 与
 * tool_call_update 如何合成一次 upsert、stopReason 怎么读成一个结局 —— 全部
 * 收在这个文件里，别处不该再出现一个 Acp 前缀。
 *
 * 它只认这条线上的方言：会话通知的词汇，以及授权请求随身携带的那份
 * ToolCallUpdate。一轮怎么开始、怎么结束归 projection —— 那两件事两条线共用，
 * 而这个文件不许知道另一条线存在。
 *
 * 它只往草稿上写，既不开草稿也不封版（见 timeline-draft），所以「纯、总、可
 * 重放」那三条性质与它无关：那是入口那一层的承诺。
 */

import type {
  AcpContentBlock,
  AcpSessionUpdate,
  AcpToolCallContent,
  AcpToolCallUpdate,
  RunEvent,
} from '@poietica/agent-contract'
import type { ToolCallTimelineItem, UserMessageItem } from './timeline-contract'
import type { Draft } from './timeline-draft'
import { appendChunk, namespace, positionOf, push } from './timeline-draft'
import { pendingPermission } from './timeline-queries'

/** 这条线上的方言帧。其余每一格两条线共用，归 projection。 */
export type AcpFrame = Extract<
  RunEvent,
  { kind: 'acp_update' | 'permission_requested' | 'permission_resolved' }
>

export function applyAcpFrame(draft: Draft, event: AcpFrame): void {
  switch (event.kind) {
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
      /* 身份是算得出来的（见 permission_requested 那一支），所以按 id 定位。 */
      const position = positionOf(draft, `${namespace(draft)}permission-${event.requestId}`)
      const asked = position < 0 ? undefined : draft.items[position]

      if (asked?.type === 'permission') {
        draft.items[position] = {
          ...asked,
          resolution: { optionId: event.optionId, outcome: event.outcome },
        }
      }

      /* 答掉一个不等于不再等。并行的子代理会同时挂着几个请求（ADR 0002）：
         第一个答复一到就写 running，会让界面说这一轮不在等人了，而另外几个
         请求还挂在原生侧的桌子上，屏幕上再没有入口。这句话必须排在上面那次
         落账之后：刚答掉的这一个也在扫描范围里。 */
      draft.status = pendingPermission(draft) === undefined ? 'running' : 'awaiting_permission'

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
      appendChunk(draft, 'agent_text', chunkOf(update, `${scope}text-`, seq, at))

      return
    }

    case 'agent_thought_chunk': {
      appendChunk(draft, 'agent_thought', chunkOf(update, `${scope}thought-`, seq, at))

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
 * 这条线上一段流式文本的身份。
 *
 * 协议给了信号：ContentChunk 带 messageId，同一条消息的每一段带同一个号。号缺席
 * 时不表态 —— 它在 schema 里本来就是可选的。协议里「没报」是 undefined、「报了个
 * 空」是 null，对边界是同一件事，归一在这里做一次。
 */
function chunkOf(
  update: AcpUpdateOf<'agent_message_chunk'> | AcpUpdateOf<'agent_thought_chunk'>,
  prefix: string,
  seq: number,
  at: number,
): { readonly at: number; readonly id: string; readonly message?: string; readonly text: string } {
  const messageId = update.messageId ?? undefined

  return {
    at,
    id: prefix + String(seq),
    text: textOf(update.content),
    ...(messageId === undefined ? {} : { message: messageId }),
  }
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
 * 第二条判成重复丢掉，而缩略导航按「问过几次」数格子，少一条就会错位。
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

  /* 段由本机发出的 prompt 开启（beginRun / appendUserMessage）。
     agent 送来的用户消息是回声或注入，不许另开一段。 */

  push(draft, {
    type: 'user_message',
    /* 段可能刚在上一句换过，所以前缀重新取一次：入口那次取的是上一段的。 */
    id: `${namespace(draft)}user-${String(seq)}`,
    turn: draft.runIndex,
    at,
    text: chunk,
  })
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
 * 是靠这一格站住的，而它带的图就在同一帧的 images 里。
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
