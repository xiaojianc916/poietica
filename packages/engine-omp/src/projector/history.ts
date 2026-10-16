import {
  applyOps,
  emptyTimeline,
  pageFromState,
  stepId,
  type TranscriptAttachment,
  type TranscriptOperation,
  type TranscriptPage,
  turnId,
} from '@poietica/transcript'
import { isGoalContinuationMessage, isUserSkillMessage, splitWireText } from '../session/prompt'
import { compactionPayloadOf } from './compaction'
import { assistantFrameId, extraFrameId, interjectionFrameId } from './frame-ids'
import { FILE_MEDIA_TYPE } from './live'
import { GOAL_CONTINUATION_ORIGIN, type TurnOrigin, userOrigin } from './origin'

/** omp 的消息形状（只取投影要读的那几格，避免绑到 omp 的深层类型） */
export interface OmpMessage {
  readonly role?: string
  readonly timestamp?: number
  readonly duration?: number
  readonly completedAt?: number
  readonly content?: unknown
  readonly customType?: string
  readonly attribution?: string
  readonly details?: unknown
  readonly display?: boolean
  readonly toolCallId?: string
  readonly isError?: boolean
  readonly summary?: string
  /** 助手消息怎么收的尾：`aborted` / `error` 说明这一次运行到这里就结束了 */
  readonly stopReason?: string
  /** omp 给插话（steer）打的标：它是在一次运行**中途**送进去的人话，不开新的一轮 */
  readonly steering?: boolean
  /* 压缩摘要（role: compactionSummary）的展示元数据：omp 把它们写在压缩条目上，显示经过里原样带出 */
  readonly shortSummary?: string
  readonly tokensBefore?: number
  readonly tokensAfter?: number
  readonly method?: string
  readonly warning?: string
}

export interface HistoryPageOptions {
  /** 一页多少轮（默认 20） */
  readonly pageSize?: number
  /** 已经是当前那一轮：留 running（屏幕上的封条还在转） */
  readonly isTurnOpen?: boolean
  /**
   * 还开着的那一轮在增量那条路上已经发过的图片条目（审查 R-19-1）。给了就让最新那一轮沿用这批号：
   * 那一轮收尾时增量那条路会再发一次整份轮头，轮头里是**它**的号 —— 历史这边另起一批号的话，
   * 收尾那一刻轮头指向界面没见过的号，图就从气泡上消失了。
   */
  readonly openTurnAttachments?: readonly TranscriptAttachment[]
}

interface ScreenResult {
  readonly content: unknown
  readonly details: unknown
  readonly isError: boolean
}

interface OpenTurn {
  readonly opening: OmpMessage
  readonly prompt: OmpMessage | null
  /** 段（助手消息）与插话（这一轮跑着时送进来的人话），按发生顺序 */
  readonly steps: OmpMessage[]
  /** 这一轮里（或这一轮之后、下一句人话之前）发生的压缩，按发生顺序 */
  readonly compactions: OmpMessage[]
  /** 这一轮的终点（毫秒）：段与工具结果里最晚的「答完那一刻」，还没落地就是 null。 */
  closedAt: number | null
  /** 这一次运行最后一次有动静的时刻（段落地、工具结果回来）：判断一句人话是不是跑着时送进来的 */
  heardAt: number | null
  /** 最后一段的收尾方式：被叫停 / 出错就是这次运行已经结束，排着的话会另起一次运行 */
  lastStop: string | undefined
}

interface ScreenTurn {
  readonly turn: number
  readonly opening: OmpMessage
  readonly prompt: OmpMessage | null
  readonly steps: readonly OmpMessage[]
  readonly compactions: readonly OmpMessage[]
  readonly openedAt: string
  readonly endedAt: string | null
  readonly state: 'running' | 'completed'
  readonly results: ReadonlyMap<string, ScreenResult>
}

/** 正文 / 思维链块带着它在 content 数组里的下标（= omp 流式事件的 contentIndex）：帧号由它派生，见 frame-ids.ts */
type ScreenBlock =
  | { readonly kind: 'text'; readonly text: string; readonly index: number }
  | { readonly kind: 'thinking'; readonly text: string; readonly index: number }
  | { readonly kind: 'tool'; readonly callId: string; readonly name: string; readonly arguments: unknown }

/**
 * 历史分页。
 *
 * **一轮从「人说的话」开始，到下一句开轮的人话为止**——与增量那条路同一个判据。跑着的时候送进去的话
 * （插话 steer、排队 followUp 在同一次运行里被吃掉的）不开轮，落进当前那一轮，见 `interjects`。一次 omp turn 里模型会跑好几趟，
 * 「一条消息一格」会把一次对话拆成好几行；这里按人话归拢，assistant 消息各占一个段，工具结果并回发起它的那次调用。
 *
 * 分页直接从 omp 的会话消息算，Core 不保存第二份正文，所以不存在两份数据不一致的问题。
 *
 * `messages` 必须是**显示经过**（omp 的 `buildTranscriptSessionContext({ collapseCompactedHistory: false })`），
 * 不是模型上下文（`session.messages`）：压缩之后模型上下文只剩「摘要 + 保留的尾巴」，拿它分页，
 * 屏幕上压缩之前的对话就全没了、轮号也从 1 重数（审查 R-21-1）。
 *
 * 压缩**不开轮**：它挂在发生时开着的那一轮后面（增量那条路也不为它开轮），轮号因此与增量那条路一致；
 * 一次 omp turn 里中途压缩，压缩之后的段仍归这一轮，而不是被吞进一格看不见正文的「压缩轮」。
 */
export function projectHistoryPage(
  messages: readonly OmpMessage[],
  beforeTurnId: string | null,
  o: HistoryPageOptions = {},
): TranscriptPage {
  const pageSize = o.pageSize ?? 20
  const { leading, turns } = screenTurns(messages, o.isTurnOpen === true)
  const before = beforeTurnId === null ? Number.POSITIVE_INFINITY : turnOrdinalOf(beforeTurnId)
  const older = turns.filter((entry) => entry.turn < before)
  const window = older.slice(Math.max(0, older.length - pageSize))
  /* 第一句人话之前的压缩只跟着最早那一页走：别的页带上它，「加载更早」时它会在中间冒出来 */
  const head = window.length === older.length ? compactionOps(0, leading) : []
  const ops = [
    ...head,
    ...window.flatMap((entry) => [
      ...turnOps(entry, o.openTurnAttachments ?? []),
      ...compactionOps(entry.turn, entry.compactions),
    ]),
  ]
  const items = itemsFromOps(ops)
  return {
    items,
    tasks: [],
    interactions: [],
    attachments: attachmentsFrom(ops),
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: older.length > window.length,
  }
}

/**
 * 每一轮的开场消息（下标 i = 第 i + 1 轮），与 `projectHistoryPage` 同一套分轮。
 * 分叉按轮号截断（`OmpSessionFilesPort.fork`）只能认这一份：分轮规则只有一个产地，屏幕上的第 n 轮与截断时的第 n 轮才是同一轮。
 */
export function turnOpenings(messages: readonly OmpMessage[]): readonly OmpMessage[] {
  return screenTurns(messages, false).turns.map((entry) => entry.opening)
}

/** 历史里最后一轮的序号；重开会话时交给 LiveProjector.seat */
export function lastTurnOrdinal(messages: readonly OmpMessage[]): number {
  return screenTurns(messages, false).turns.at(-1)?.turn ?? 0
}

function turnOrdinalOf(id: string): number {
  const n = Number(id.replace(/^t/, ''))
  return Number.isFinite(n) ? n : 0
}

function screenTurns(
  messages: readonly OmpMessage[],
  isTurnOpen: boolean,
): { readonly leading: readonly OmpMessage[]; readonly turns: ScreenTurn[] } {
  const results = resultsOf(messages)
  const turns: ScreenTurn[] = []
  const leading: OmpMessage[] = []
  let open: OpenTurn | null = null
  const seal = (): void => {
    if (open === null) return
    const held = open
    open = null
    const turn = turns.length + 1
    turns.push({
      turn,
      opening: held.opening,
      prompt: held.prompt,
      steps: held.steps,
      compactions: held.compactions,
      openedAt: stampOf(held.prompt ?? held.opening),
      endedAt: held.closedAt === null ? null : new Date(held.closedAt).toISOString(),
      state: 'completed',
      results,
    })
  }
  for (const message of messages) {
    const role = roleOf(message)
    if (role === 'skip') continue
    if (role === 'compaction') {
      if (open === null) leading.push(message)
      else open.compactions.push(message)
      continue
    }
    /* 工具结果与系统通知都不上屏：只记下这次运行此刻还有动静（插话判据要用） */
    if (role === 'heard') {
      if (open !== null) open.heardAt = laterOf(open.heardAt, closedAtOf(message))
      continue
    }
    if (role === 'prompt' && open !== null && interjects(open, message)) {
      open.steps.push(message)
      continue
    }
    if (role !== null) {
      seal()
      open = blankTurn(message, role === 'prompt' ? message : null)
      continue
    }
    if (open === null) open = blankTurn(message, null)
    open.steps.push(message)
    open.closedAt = laterOf(open.closedAt, closedAtOf(message))
    open.heardAt = laterOf(open.heardAt, closedAtOf(message))
    open.lastStop = message.stopReason
  }
  seal()
  const newest = turns.at(-1)
  return {
    leading,
    turns:
      newest !== undefined && isTurnOpen
        ? [...turns.slice(0, -1), { ...newest, state: 'running', endedAt: null }]
        : turns,
  }
}

function blankTurn(opening: OmpMessage, prompt: OmpMessage | null): OpenTurn {
  return { opening, prompt, steps: [], compactions: [], closedAt: null, heardAt: null, lastStop: undefined }
}

/**
 * 这句人话是不是在这一轮**跑着的时候**送进来的（插话）。增量那条路的判据是「送达那一刻有没有一轮开着」
 * （`LiveProjector.steeredFrame`）：开着就落进这一轮成一句插话，不开新轮、不另起封条。重开之后的屏幕
 * 必须与当时一致，所以这里从落了盘的消息里还原同一件事：
 *
 * - **上一段被叫停或出错了**：那次运行已经结束，排着的话会由 omp 另起一次运行 —— 实时那边是新的一轮；
 * - **omp 打了插话标**（`steering: true`）：只有跑着时排进插话队列的话才有；
 * - **提交时刻早于这次运行最后一次动静**：人话的 `timestamp` 是**提交**那一刻，不是送达那一刻。
 *   排队（followUp）那条路没有标，但它在跑着的时候就提交了，送达却在之后 —— 新开一轮的话只能在
 *   上一轮收完之后才发得出来（界面在跑着时一律走排队），时刻一定更晚。
 */
function interjects(open: OpenTurn, message: OmpMessage): boolean {
  if (open.lastStop === 'aborted' || open.lastStop === 'error') return false
  if (message.steering === true) return true
  const submitted = message.timestamp
  return (
    open.heardAt !== null && typeof submitted === 'number' && Number.isFinite(submitted) && submitted < open.heardAt
  )
}

/**
 * 一条消息在分轮上的角色：开一轮的两种（人话 / 目标续跑）、压缩摘要（挂在当前这一轮后面，不开轮）、
 * 只记时刻的（heard：工具结果与系统通知，不上屏，只记它到达的时刻）、不进屏幕的（skip）、其余的（null，落进当前这一轮）。
 *
 * 目标续跑的开场消息是 display:false 的 custom 消息，但它**开一轮**（审查 R-11）—— * 增量那条路在同一处开轮（LiveProjector.goalContinuationTurn）；这里不认它，续跑的输出就会
 * 并进上一句人话那一轮，重开之后屏幕上的轮数、轮号都与刚才跑的时候对不上。
 */
function roleOf(message: OmpMessage): 'prompt' | 'continuation' | 'compaction' | 'heard' | 'skip' | null {
  if (isGoalContinuationMessage(message)) return 'continuation'
  if (message.role === 'toolResult') return 'heard'
  if (!isVisible(message)) return 'skip'
  if (isHarnessNotice(message)) return 'heard'
  if (message.role === 'user' || isUserSkillMessage(message)) return 'prompt'
  return message.role === 'compactionSummary' ? 'compaction' : null
}

function resultsOf(messages: readonly OmpMessage[]): Map<string, ScreenResult> {
  const results = new Map<string, ScreenResult>()
  for (const message of messages) {
    if (message.role !== 'toolResult') continue
    const callId = message.toolCallId
    if (typeof callId === 'string' && callId !== '') {
      results.set(callId, { content: message.content, details: message.details, isError: message.isError === true })
    }
  }
  return results
}

/**
 * omp 写给**模型**看的系统通知（审查 R-25）：后台任务做完了（`async-result`）、受管进程退出了
 * （`launch-completion`）、迟到的 LSP 诊断（`lsp-late-diagnostic`）。它们是 role:custom、display:true ——
 * omp 的终端界面给它们各画一张专用卡片，不是正文；正文是 `<system-notice>` 包着的任务原始输出。
 * 不认它的话它就落进「这一轮里的一段」，整段原文（命令输出、脚本源码）被画成助手说的话。
 * 实时那条路本来就不画它（它没有流式正文），这里不画，重开之后与当时一致。
 *
 * 除了这三个类型，**正文以 harness 标签开头**的 custom 消息也算（`<system-…>` / `<irc>`，omp 的
 * `harness-tags.ts` 同一套名字）：系统提示词告诉模型这种块是外壳写的，不是谁说的话。
 */
const HARNESS_NOTICE_TYPES: ReadonlySet<string> = new Set(['async-result', 'launch-completion', 'lsp-late-diagnostic'])
const HARNESS_TAG_OPENING = /^\s*<\s*(?:irc|system-[a-z][a-z-]*)(?![\w-])/i

function isHarnessNotice(message: OmpMessage): boolean {
  if (message.role !== 'custom') return false
  if (typeof message.customType === 'string' && HARNESS_NOTICE_TYPES.has(message.customType)) return true
  return HARNESS_TAG_OPENING.test(leadingTextOf(message.content))
}

/** 正文开头那一段文字（字符串，或块数组里的第一个文本块） */
function leadingTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const first = (content as readonly { readonly type?: unknown; readonly text?: unknown }[]).find(
    (block) => block.type === 'text' && typeof block.text === 'string',
  )
  return typeof first?.text === 'string' ? first.text : ''
}

/** omp 给合成的横幅打了 display: false（目标模式的 <goal_context>）——它是给模型看的上下文，不是用户说过的话 */
function isVisible(message: OmpMessage): boolean {
  return message.display !== false
}

/**
 * 压缩那几格：号是 `compaction-<所挂的轮号>-<这一轮里的第几次>`，与增量那条路的号（compaction-live-*）
 * 分属两个名字空间 —— 整页重取会把增量那几格整个换掉，两边不必对号，也就不会互相盖掉。
 * 落了盘的压缩一定已经做完：这里只有 completed，没有 running（审查 R-21-2：从前按「最新一轮还开着」
 * 把它标成 running，中途压缩之后这一行就永远停在「正在压缩上下文…」）。
 */
function compactionOps(turn: number, compactions: readonly OmpMessage[]): TranscriptOperation[] {
  return compactions.map(
    (message, index): TranscriptOperation => ({
      op: 'marker.upsert',
      item: {
        kind: 'marker',
        markerId: `compaction-${String(turn)}-${String(index + 1)}`,
        marker: 'compaction',
        at: stampOf(message),
        payload: compactionPayloadOf(message),
      },
    }),
  )
}

function turnOps(entry: ScreenTurn, openTurnAttachments: readonly TranscriptAttachment[]): TranscriptOperation[] {
  const turn = turnId(entry.turn)
  const attached = [
    ...promptImagesOf(entry, openTurnAttachments),
    ...(entry.prompt === null ? [] : filesOf(entry.prompt, entry.openedAt)),
  ]
  /* 轮头必须带上号（审查 R-19-1）：界面只按轮头的 attachmentIds 找图与文件，只发条目不挂号 = 重开之后它们全部消失。 */
  const ops: TranscriptOperation[] = [
    turnOp(
      entry,
      attached.map((op) => op.attachment.attachmentId),
    ),
    ...attached,
  ]
  /*
   * 帧号按 omp 的消息身份数（与增量那条路同一个口径，见 frame-ids.ts）：这一轮里第几条助手消息、第几句插话。
   * 助手消息即便一块都不上屏也要占一个号 —— 增量那条路在 message_start 就数了它。
   */
  const seen = { assistant: -1, extra: -1, interjections: 0 }
  let step = 0
  for (const message of entry.steps) {
    if (roleOf(message) === 'prompt') {
      seen.interjections += 1
      ops.push(...interjectionOps(turn, step, message, interjectionFrameId(turn, seen.interjections)))
      step += 1
      continue
    }
    const idOf = frameIdsOf(turn, message, seen)
    const at = stampOf(message)
    const done = closedIsoOf(message)
    const blocks = shownBlocksOf(entry, message)
    let frame = 0
    if (blocks.length === 0) continue
    ops.push(stepOp(turn, step, 'completed', at, done))
    for (const block of blocks) {
      if (block.kind === 'tool') {
        // 一次工具调用占一个新段：入参与结果分成两段会被投影层认成两次调用
        if (frame > 0) {
          step += 1
          frame = 0
          ops.push(stepOp(turn, step, 'completed', at, done))
        }
        ops.push(toolOp(turn, step, block, entry.results.get(block.callId)))
        continue
      }
      ops.push(frameOp(turn, step, idOf(block.index), block))
      frame += 1
    }
    step += 1
  }
  return entry.state === 'running' ? markLastStepRunning(ops, turn) : ops
}

/** 这条消息里块下标 → 帧号；助手消息与其余上屏消息各数各的（只有助手消息在增量那条路上有对应） */
function frameIdsOf(
  turn: string,
  message: OmpMessage,
  seen: { assistant: number; extra: number },
): (block: number) => string {
  if (message.role === 'assistant') {
    seen.assistant += 1
    const ordinal = seen.assistant
    return (block) => assistantFrameId(turn, ordinal, block)
  }
  seen.extra += 1
  const ordinal = seen.extra
  return (block) => extraFrameId(turn, ordinal, block)
}

/**
 * 一句插话：与增量那条路（`LiveProjector.steeredFrame`）同一个形状 —— 一条 role:user、origin:user 的文本帧，
 * 图先发条目、帧上挂号。它自占一段：前后的段都是助手的产出，插话夹在中间。
 */
function interjectionOps(turn: string, step: number, message: OmpMessage, id: string): TranscriptOperation[] {
  const at = stampOf(message)
  const attached = [...imagesOf(message.content, at), ...filesOf(message, at)]
  const attachmentIds = attached.map((op) => op.attachment.attachmentId)
  return [
    stepOp(turn, step, 'completed', at, at),
    ...attached,
    {
      op: 'frame.upsert',
      turnId: turn,
      stepId: stepId(turn, step),
      frame: {
        kind: 'text',
        role: 'user',
        frameId: id,
        text: promptTextOf(message),
        origin: { kind: 'user' },
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      },
    },
  ]
}

/**
 * 封了口的那一轮里没有结果的调用不上屏：与 omp 剥悬挂调用同一个口径。开着的那一轮要留着 ——
 * 它正在跑（适配器为此让 omp 保留悬挂调用，keepDanglingToolCalls），剥掉它，屏幕上那一行就没了。
 */
function shownBlocksOf(entry: ScreenTurn, message: OmpMessage): readonly ScreenBlock[] {
  const blocks = contentOf(message)
  if (entry.state === 'running') return blocks
  return blocks.filter((block) => block.kind !== 'tool' || entry.results.has(block.callId))
}

/** 只有最后一个段能在跑着的时候留 running：段永远停在进行中，屏幕上那一行就一直转 */
function markLastStepRunning(ops: TranscriptOperation[], turn: string): TranscriptOperation[] {
  const at = ops.findLastIndex((op) => op.op === 'step.upsert' && op.turnId === turn)
  if (at < 0) return ops
  return ops.map((op, index): TranscriptOperation => {
    if (index !== at || op.op !== 'step.upsert') return op
    const { endedAt: _dropped, ...rest } = op.step
    return { ...op, step: { ...rest, state: 'running' } }
  })
}

function turnOp(entry: ScreenTurn, attachmentIds: readonly string[]): TranscriptOperation {
  const skills = entry.prompt === null ? [] : skillNamesOf(entry.prompt)
  return {
    op: 'turn.upsert',
    turn: {
      kind: 'turn',
      turnId: turnId(entry.turn),
      ordinal: entry.turn,
      state: entry.state,
      origin: originOf(entry, skills),
      ...(entry.prompt === null ? {} : { prompt: promptTextOf(entry.prompt) }),
      startedAt: entry.openedAt,
      ...(entry.endedAt === null ? {} : { endedAt: entry.endedAt }),
      ...(attachmentIds.length === 0 ? {} : { attachmentIds: [...attachmentIds] }),
    },
  }
}

/** 这一轮的来源：续跑那一轮是 GOAL_CONTINUATION_ORIGIN（与 live 同一个形状），其余都是人话 */
function originOf(entry: ScreenTurn, skills: readonly string[]): TurnOrigin {
  if (isGoalContinuationMessage(entry.opening)) return GOAL_CONTINUATION_ORIGIN
  return userOrigin(skills)
}

function skillNamesOf(message: OmpMessage): readonly string[] {
  const name = detailsField(message, 'name')
  return typeof name === 'string' && name !== '' ? [name] : []
}

function promptTextOf(message: OmpMessage): string {
  const prompt = detailsField(message, 'prompt')
  const args = detailsField(message, 'args')
  if (typeof prompt === 'string' && prompt !== '') return prompt
  if (typeof args === 'string' && args !== '') return args
  /* 会话文件里存的是投递正文：末尾那几行文件引用是给模型的，气泡上画的是用户原文（文件另走 `filesOf`）。 */
  return message.role === 'user' ? splitWireText(textOf(message.content)).text : textOf(message.content)
}

function detailsField(message: OmpMessage, key: string): unknown {
  const details = message.details
  return typeof details === 'object' && details !== null ? Reflect.get(details, key) : undefined
}

function stepOp(
  turn: string,
  ordinal: number,
  state: 'running' | 'completed',
  startedAt: string,
  endedAt: string,
): TranscriptOperation {
  return {
    op: 'step.upsert',
    turnId: turn,
    step: { kind: 'step', stepId: stepId(turn, ordinal), turnId: turn, ordinal, state, startedAt, endedAt },
  }
}

function frameOp(
  turn: string,
  step: number,
  id: string,
  block: Extract<ScreenBlock, { kind: 'text' | 'thinking' }>,
): TranscriptOperation {
  return {
    op: 'frame.upsert',
    turnId: turn,
    stepId: stepId(turn, step),
    frame:
      block.kind === 'text'
        ? { kind: 'text', role: 'assistant', frameId: id, text: block.text }
        : { kind: 'thinking', frameId: id, text: block.text },
  }
}

/** 一次工具调用：调用与结果同一帧（同一个 frameId 的两次 upsert）；details 必须带上 */
function toolOp(
  turn: string,
  step: number,
  block: Extract<ScreenBlock, { kind: 'tool' }>,
  result: ScreenResult | undefined,
): TranscriptOperation {
  return {
    op: 'frame.upsert',
    turnId: turn,
    stepId: stepId(turn, step),
    frame: {
      kind: 'tool',
      frameId: `tool.${block.callId}`,
      toolCallId: block.callId,
      name: block.name,
      state: result === undefined ? 'running' : result.isError ? 'error' : 'done',
      input: block.arguments,
      ...(result === undefined
        ? {}
        : {
            output: { content: result.content, details: result.details },
            ...(result.isError ? { error: textOf(result.content) } : {}),
          }),
    },
  }
}

function contentOf(message: OmpMessage): readonly ScreenBlock[] {
  const content = message.content
  if (typeof content === 'string') return content === '' ? [] : [{ kind: 'text', text: content, index: 0 }]
  if (!Array.isArray(content)) return []
  const blocks: ScreenBlock[] = []
  for (const [index, value] of (content as readonly Record<string, unknown>[]).entries()) {
    const parsed = blockOf(value, index)
    if (parsed !== undefined) blocks.push(parsed)
  }
  return blocks
}

function blockOf(block: Record<string, unknown>, index: number): ScreenBlock | undefined {
  const kind = block.type
  if (kind === 'text' && typeof block.text === 'string' && block.text !== '') {
    return { kind: 'text', text: block.text, index }
  }
  if (kind === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
    return { kind: 'thinking', text: block.thinking, index }
  }
  if (kind === 'toolCall' && typeof block.id === 'string' && block.id !== '') {
    return {
      kind: 'tool',
      callId: block.id,
      name: typeof block.name === 'string' ? block.name : '',
      arguments: block.arguments,
    }
  }
  return undefined
}

/** 正文帧只装文字：图片块另走 attachmentOp */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return (value as readonly { readonly type?: unknown; readonly text?: unknown }[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

type AttachmentUpsert = Extract<TranscriptOperation, { op: 'attachment.upsert' }>

/**
 * 这一轮开头那句人话的图片条目。还开着的那一轮优先沿用增量那条路发过的那一批（号与像素都相同）；
 * 只有张数对得上才沿用 —— 对不上说明 omp 的消息里还没有这一句（或者根本不是同一句），各用各的号更安全。
 */
function promptImagesOf(entry: ScreenTurn, openTurnAttachments: readonly TranscriptAttachment[]): AttachmentUpsert[] {
  const fromHistory = imagesOf(entry.prompt === null ? undefined : entry.prompt.content, entry.openedAt)
  if (entry.state !== 'running' || openTurnAttachments.length === 0) return fromHistory
  if (openTurnAttachments.length !== fromHistory.length) return fromHistory
  return openTurnAttachments.map((attachment) => ({ op: 'attachment.upsert', attachment }))
}

/**
 * 用户消息里的图片。omp 读会话时已把 blob 换回内联 base64，所以像素此刻就在手上。
 * 号必须跨消息唯一：号里带上这条消息的时刻，否则两条各带一张图的用户消息会撞号、后一张覆盖前一张。
 */
function imagesOf(content: unknown, stamp: string): AttachmentUpsert[] {
  if (!Array.isArray(content)) return []
  const ops: AttachmentUpsert[] = []
  for (const [index, value] of content.entries()) {
    const block = value as { readonly type?: unknown; readonly data?: unknown; readonly mimeType?: unknown }
    if (block.type !== 'image' || typeof block.data !== 'string' || block.data === '') continue
    const mediaType = typeof block.mimeType === 'string' ? block.mimeType : 'image/png'
    const attachmentId = `${stamp}#${String(index)}`
    ops.push({
      op: 'attachment.upsert',
      attachment: {
        attachmentId,
        mediaType,
        source: {
          kind: 'url',
          url: block.data.startsWith('data:') ? block.data : `data:${mediaType};base64,${block.data}`,
        },
      },
    })
  }
  return ops
}

/**
 * 用户消息带的普通文件：从投递正文末尾那几行引用读回名字（见 `wireTextOf`）。旧会话的引用行没有名字，
 * 条目也照样发 —— 界面给它一个泛称，比把一串内容寻址路径画在气泡里强。号的 `#f` 与图片的 `#序号` 分属两个名字空间。
 */
function filesOf(message: OmpMessage, stamp: string): AttachmentUpsert[] {
  if (message.role !== 'user') return []
  return splitWireText(textOf(message.content)).files.map(
    (file, index): AttachmentUpsert => ({
      op: 'attachment.upsert',
      attachment: {
        attachmentId: `${stamp}#f${String(index)}`,
        mediaType: FILE_MEDIA_TYPE,
        ...(file.name === undefined ? {} : { name: file.name }),
      },
    }),
  )
}

function stampOf(message: OmpMessage): string {
  return typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : new Date(0).toISOString()
}

function closedAtOf(message: OmpMessage): number | undefined {
  const start = message.timestamp
  if (typeof start !== 'number' || !Number.isFinite(start)) return undefined
  const completed = message.completedAt
  if (typeof completed === 'number' && Number.isFinite(completed)) return Math.max(completed, start)
  const duration = message.duration
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? start + duration : start
}

function laterOf(held: number | null, stamp: number | undefined): number | null {
  if (stamp === undefined) return held
  return held === null ? stamp : Math.max(held, stamp)
}

/** 与 `stampOf` 同一个回退口径的落地时刻；`stampOf` 负责开始，它负责结束。 */
function closedIsoOf(message: OmpMessage): string {
  const closed = closedAtOf(message)
  return closed === undefined ? stampOf(message) : new Date(closed).toISOString()
}

/** 用 transcript 的折叠器把 ops 变成 items：step/frame 的嵌套与覆盖由它负责，这里不写第二份 */
function itemsFromOps(ops: readonly TranscriptOperation[]): TranscriptPage['items'] {
  return pageFromState(applyOps(emptyTimeline(), ops)).items
}
function attachmentsFrom(ops: readonly TranscriptOperation[]): TranscriptPage['attachments'] {
  return ops.flatMap((op) => (op.op === 'attachment.upsert' ? [op.attachment] : []))
}
