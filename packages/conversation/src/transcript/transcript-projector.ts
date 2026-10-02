import type {
  AgentTranscriptSnapshot,
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptMarker,
  TranscriptTask,
  TranscriptTurn,
} from '@poietica/transcript'
import type { QuestionChoice, QuestionItem } from '../agent/question'
import type { TurnMark } from '../agent/thread'
import type { ToolCallContent } from '../agent/tool-call'
import type {
  BackgroundTaskItem,
  CompactionState,
  CompactionTimelineItem,
  MessageFile,
  MessageImage,
  PermissionItem,
  QuestionTimelineItem,
  SubagentItem,
  TimelineItem,
  TimelineState,
  ToolCallTimelineItem,
  TurnPage,
  TurnSpan,
  UserMessageItem,
} from '../timeline/timeline-contract'

import { fileMetaLabel, isInFlight } from '../timeline/timeline-contract'
import { withoutKimiAttachmentNotices } from './kimi-attachment'
import { ompToolView } from './omp-tool-view'
import { describeTool } from './tool-vocabulary'

function timeOf(value?: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const stamp = Date.parse(value)
  return Number.isFinite(stamp) ? stamp : undefined
}
const at = (value?: string): number => timeOf(value) ?? 0
const statusOf = (state: TranscriptTurn['state']): TimelineState['status'] =>
  state === 'queued'
    ? 'submitted'
    : state === 'running'
      ? 'running'
      : state === 'cancelled'
        ? 'cancelled'
        : state === 'failed'
          ? 'failed'
          : 'completed'
const textContent = (value: unknown): readonly ToolCallContent[] =>
  typeof value === 'string' && value.length > 0
    ? [{ type: 'content', content: { type: 'text', text: value } }]
    : []

// 工具入参是模型写的任意值，不能假定可序列化；循环引用时退回空。
function jsonOf(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return undefined
  }
}

interface InputSource {
  readonly isUser: boolean
  readonly anchors: number | null
}

const USER_INPUT: InputSource = { isUser: true, anchors: 1 }

const originField = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

function skillNamesOf(origin: unknown): readonly string[] {
  const activations = originField(origin, 'skillActivations')
  if (!Array.isArray(activations)) {
    return []
  }
  const names: string[] = []
  for (const activation of activations) {
    const name = originField(activation, 'skillName')
    if (typeof name === 'string' && name.length > 0) {
      names.push(name)
    }
  }
  return names
}

function sourceOfTurn(turn: TranscriptTurn): InputSource {
  const { origin } = turn
  const kind = originField(origin.payload, 'kind')
  const slash =
    (kind === 'skill_activation' || kind === 'plugin_command') &&
    originField(origin.payload, 'trigger') === 'user-slash'
  if (origin.kind === 'other' && slash) {
    return USER_INPUT
  }
  if (origin.kind === 'user') {
    if (kind === undefined || kind === 'user') {
      return USER_INPUT
    }
    if (kind === 'shell_command') {
      return { isUser: originField(origin.payload, 'phase') === 'input', anchors: 0 }
    }
    return { ...USER_INPUT, anchors: null }
  }
  return { isUser: false, anchors: origin.kind === 'other' ? null : 0 }
}

function sourceOfFrame(frame: Extract<TranscriptFrame, { role: 'user' }>): InputSource {
  if (frame.origin?.kind === 'user') {
    return { ...USER_INPUT, anchors: (frame.promptIds?.length ?? 0) > 1 ? null : 1 }
  }
  return { isUser: false, anchors: frame.taskId === undefined ? null : 0 }
}

interface TurnAttachments {
  readonly images: MessageImage[]
  readonly files: MessageFile[]
}

const NO_TURN_ATTACHMENTS: TurnAttachments = { images: [], files: [] }

// 历史图片在 agent media 端点后（要 Bearer），由 store 经原生侧代取后填进这张表。
const EMPTY_MEDIA: ReadonlyMap<string, string> = new Map()
const EMPTY_INDEX: ReadonlyMap<string, TranscriptAttachment> = new Map()

// 判据是有没有能取回像素的 source，不是 media_type：给不了 source 的本来就只能是卡片。
function imageUrlOf(
  attachment: TranscriptAttachment,
  media: ReadonlyMap<string, string>,
): string | undefined {
  const { source } = attachment
  if (source === undefined) {
    return undefined
  }
  if (source.kind === 'url') {
    return source.url
  }
  return media.get(source.fileId)
}

const isDrawableImage = (attachment: TranscriptAttachment): boolean =>
  attachment.mediaType.startsWith('image/') && attachment.source !== undefined

export const needsMediaFetch = (attachment: TranscriptAttachment): boolean =>
  isDrawableImage(attachment) && attachment.source?.kind !== 'url'

function attachmentsOfTurn(
  turn: TranscriptTurn,
  index: ReadonlyMap<string, TranscriptAttachment>,
  media: ReadonlyMap<string, string>,
): TurnAttachments {
  const ids = turn.attachmentIds
  if (ids === undefined || ids.length === 0) {
    return NO_TURN_ATTACHMENTS
  }
  const images: MessageImage[] = []
  const files: MessageFile[] = []
  for (const id of ids) {
    const attachment = index.get(id)
    if (attachment === undefined) {
      continue
    }
    if (isDrawableImage(attachment)) {
      const url = imageUrlOf(attachment, media)
      images.push(url === undefined ? { pending: true } : { url })
    } else {
      const name = attachment.name ?? '附件'
      files.push({ name, meta: fileMetaLabel(name, attachment.size) })
    }
  }
  return { images, files }
}

// 只有真用户输入才成行；正文里混着给模型看的附件句子，在这里摘掉。
function inputItem(
  source: InputSource,
  id: string,
  turn: number,
  stamp: number,
  text: string,
  skills: readonly string[],
  attached: TurnAttachments = NO_TURN_ATTACHMENTS,
): UserMessageItem | null {
  return source.isUser
    ? {
        type: 'user_message',
        id,
        turn,
        at: stamp,
        text: withoutKimiAttachmentNotices(text),
        ...(attached.images.length === 0 ? {} : { images: attached.images }),
        ...(attached.files.length === 0 ? {} : { files: attached.files }),
        ...(skills.length === 0 ? {} : { skills }),
      }
    : null
}

const isSettled = (state: TranscriptTurn['state']): boolean =>
  state === 'completed' || state === 'cancelled' || state === 'failed'

/** 文本帧：助手那句是已封口的正文，用户那句要过 sourceOfFrame 才认得出是不是真输入。 */
function textFrameOf(
  frame: Extract<TranscriptFrame, { kind: 'text' }>,
  turn: number,
  stamp: number,
): TimelineItem | null {
  if (frame.role === 'assistant') {
    return {
      type: 'agent_text',
      id: frame.frameId,
      turn,
      at: stamp,
      text: frame.text,
      sealed: true,
    }
  }
  return inputItem(
    sourceOfFrame(frame),
    frame.frameId,
    turn,
    stamp,
    frame.text,
    skillNamesOf(frame.origin),
  )
}

function toolFrameOf(
  frame: Extract<TranscriptFrame, { kind: 'tool' }>,
  turn: number,
  stamp: number,
): ToolCallTimelineItem {
  const view = ompToolView(frame.name, frame.input, frame.output, frame.error, frame.intent)
  // describeTool 只在 view 不认识该工具或 subject 为空时才需要，避免 15k 次无用 Reflect.get
  const tool = view.known && view.subject ? undefined : describeTool(frame.input)
  return {
    type: 'tool_call',
    id: frame.frameId,
    turn,
    at: stamp,
    toolCallId: frame.toolCallId,
    title: frame.name,
    kind: view.known ? view.kind : (tool?.kind ?? 'other'),
    headline: view.headline,
    subject: view.subject || (tool?.subject ?? ''),
    shape: view.shape,
    ...(view.background ? { isBackground: true as const } : {}),
    status:
      frame.state === 'running' ? 'in_progress' : frame.state === 'error' ? 'failed' : 'completed',
    requestContent: view.request.length > 0 ? view.request : textContent(jsonOf(frame.input)),
    content: view.response.length > 0 ? view.response : textContent(frame.error ?? frame.output),
    locations: [],
    channels:
      frame.agentRefs === undefined || frame.agentRefs.length === 0
        ? []
        : frame.agentRefs.map((agent) => ({
            agentId: agent.agentId,
            name: agent.agentId,
          })),
    rawInput: frame.input,
    rawOutput: frame.output,
    startedAt: stamp,
    ...(frame.state === 'running' ? {} : { endedAt: stamp }),
  } satisfies ToolCallTimelineItem
}

/** 一帧换一格：判别式只此一处，四种帧各交回自己那一格。 */
function frameOf(frame: TranscriptFrame, turn: number, stamp: number): TimelineItem | null {
  switch (frame.kind) {
    case 'text':
      return textFrameOf(frame, turn, stamp)
    case 'thinking':
      return {
        type: 'agent_thought',
        id: frame.frameId,
        turn,
        at: stamp,
        text: frame.text,
        sealed: true,
      }
    case 'notice':
      return { type: 'error', id: frame.frameId, turn, at: stamp, message: frame.message }
    case 'tool':
      return toolFrameOf(frame, turn, stamp)
  }
}
const approvalDecision = (state: TranscriptInteraction['state']) =>
  state === 'approved' ? 'approved' : state === 'rejected' ? 'rejected' : 'cancelled'
const questionOutcome = (state: TranscriptInteraction['state']) =>
  state === 'answered' ? 'answered' : state === 'dismissed' ? 'dismissed' : 'cancelled'

/** 审批那一格请求里我们要读的：工具名，以及上游算好的「将做什么」。 */
function approvalFields(request: unknown): { toolName: string; detail: string | null } {
  if (typeof request !== 'object' || request === null) {
    return { toolName: '', detail: null }
  }
  const toolName = Reflect.get(request, 'toolName')
  const detail = Reflect.get(request, 'detail')

  return {
    toolName: typeof toolName === 'string' ? toolName : '',
    detail: typeof detail === 'string' && detail !== '' ? detail : null,
  }
}

function interactionOf(
  interaction: TranscriptInteraction,
  turn: number,
  stamp: number,
): PermissionItem | QuestionTimelineItem {
  const resolved = interaction.state !== 'pending'
  if (interaction.interactionKind === 'approval') {
    const { toolName, detail } = approvalFields(interaction.request)

    /*
     * 主语取上游算好的那一段（`Command: rm -rf …` 这类），不是工具名：判据是「要不要
     * 让它做这件事」，而工具名回答不了。说不出来才退到工具名，再退到一句中性的字。
     *
     * 用 headline 而不是 subject：headline 是多行原文，sayToolLine 只截第一行 ——
     * 它正是给这件事用的那一格（tool-intent.ts）。
     */
    const said = detail ?? toolName

    return {
      type: 'permission',
      id: interaction.interactionId,
      turn,
      at: stamp,
      requestId: interaction.interactionId,
      title: said === '' ? 'Approval' : said,
      ...(said === '' ? {} : { headline: said }),
      kind: 'other',
      subject: toolName,
      locations: [],
      ...(resolved ? { resolution: { decision: approvalDecision(interaction.state) } } : {}),
    }
  }
  const request =
    typeof interaction.request === 'object' && interaction.request !== null
      ? interaction.request
      : {}
  const questions = (
    Array.isArray(Reflect.get(request, 'questions')) ? Reflect.get(request, 'questions') : []
  ) as readonly QuestionItem[]
  return {
    type: 'question',
    id: interaction.interactionId,
    turn,
    at: stamp,
    questionId: interaction.interactionId,
    ...(interaction.toolCallId === undefined ? {} : { toolCallId: interaction.toolCallId }),
    questions,
    ...(resolved
      ? {
          resolution: {
            outcome: questionOutcome(interaction.state),
            answers: answersOf(interaction.response),
            note: noteOf(interaction.response),
          },
        }
      : {}),
  }
}

/*
 * 人答了什么，从答复里读回来。
 *
 * 答复有两个产地，形状不同，都得认：
 * - 现场：桥把**产品形状**的答复挂在 `answers` 上（questions.ts 的 answerPayloadOf 的入参），
 *   键是题号，值就是 QuestionChoice；
 * - 回放：本机账本存的是 `[{questionId, answer}]`（question.rs 的 AnsweredQuestion）。
 *
 * 读不出来就给空表 —— 题面还在，答案那行缺席，比编一个「答过了」强。
 */
function answersOf(response: unknown): Readonly<Record<string, QuestionChoice>> {
  if (typeof response !== 'object' || response === null) {
    return {}
  }

  const value = Reflect.get(response, 'answers')
  const answers: Record<string, QuestionChoice> = {}

  if (Array.isArray(value)) {
    for (const entry of value) {
      const id = readId(entry)
      const answer = readAnswer(entry)

      if (id !== undefined && answer !== undefined) {
        answers[id] = answer
      }
    }

    return answers
  }

  if (typeof value !== 'object' || value === null) {
    return {}
  }

  for (const [id, answer] of Object.entries(value)) {
    const read = readAnswer({ answer })

    if (read !== undefined) {
      answers[id] = read
    }
  }

  return answers
}

function readId(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }

  const id = Reflect.get(entry, 'questionId')

  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 一条答复：判别式与分支名是协议取值域（question.rs 的 QuestionAnswer）。 */
function readAnswer(entry: unknown): QuestionChoice | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }

  const answer: unknown = Reflect.get(entry, 'answer')

  if (typeof answer !== 'object' || answer === null) {
    return undefined
  }

  switch (Reflect.get(answer, 'kind')) {
    case 'single': {
      const optionId = Reflect.get(answer, 'optionId')

      return typeof optionId === 'string' ? { kind: 'single', optionId } : undefined
    }
    case 'multi': {
      const optionIds = stringsOf(Reflect.get(answer, 'optionIds'))

      return optionIds === undefined ? undefined : { kind: 'multi', optionIds }
    }
    case 'other': {
      const text = Reflect.get(answer, 'text')

      return typeof text === 'string' ? { kind: 'other', text } : undefined
    }
    case 'multi_with_other': {
      const optionIds = stringsOf(Reflect.get(answer, 'optionIds'))
      const otherText = Reflect.get(answer, 'otherText')

      return optionIds === undefined || typeof otherText !== 'string'
        ? undefined
        : { kind: 'multi_with_other', optionIds, otherText }
    }
    case 'skipped':
      return { kind: 'skipped' }
    default:
      return undefined
  }
}

function stringsOf(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

/** 整组题的备注；上游每题一格，产品整组一格，所以取那一格。 */
function noteOf(response: unknown): string {
  if (typeof response !== 'object' || response === null) {
    return ''
  }

  const note = Reflect.get(response, 'note')

  return typeof note === 'string' ? note : ''
}
const backgroundOf = (task: TranscriptTask): BackgroundTaskItem | null => {
  /*
   * 子代理不走这一格：它们是「智能体」那一节的，见 subagentOf。`detached` 只说明
   * 「父轮不等它」，不说明它是什么 —— 只按 detached 分派就是那条缺陷本身。
   */
  if (!task.detached || task.kind === 'subagent') {
    return null
  }
  const startedAt = timeOf(task.startedAt)
  const endedAt = timeOf(task.endedAt)
  return {
    taskId: task.taskId,
    description: task.description ?? task.taskId,
    status: task.state,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

/*
 * 子代理那一行。
 *
 * 判据是 `kind === 'subagent'`，不是 `detached`：`detached` 说的是「父轮不等它」，
 * 而**同步**子代理同样要出现在「智能体」那一节（官方 TUI 的 HUD 也列它们）。
 * 按 detached 分派正是此前那条缺陷 —— 子代理会被塞进「后台任务」，而那一节的图标
 * 是终端、那一格的名字叫 terminals。
 */
const subagentOf = (task: TranscriptTask): SubagentItem | null => {
  if (task.kind !== 'subagent') {
    return null
  }
  const startedAt = timeOf(task.startedAt)
  const endedAt = timeOf(task.endedAt)
  return {
    agentId: task.agentId ?? task.taskId,
    description: task.description ?? task.taskId,
    status: task.state,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

function spanOf(turn: TranscriptTurn, index: number): TurnSpan {
  const startedAt = timeOf(turn.startedAt)
  const endedAt = timeOf(turn.endedAt)
  const durationMs = turn.durationMs
  let lastFrameAt = endedAt ?? startedAt
  for (const step of turn.steps) {
    for (const value of [step.startedAt, step.endedAt]) {
      const stamp = timeOf(value)
      if (stamp !== undefined) {
        lastFrameAt = Math.max(lastFrameAt ?? stamp, stamp)
      }
    }
  }
  return {
    turn: index,
    ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs }
      : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(lastFrameAt === undefined ? {} : { lastFrameAt }),
  }
}

/*
 * 答完的题挂回发起它的**那次调用**下面。
 *
 * 判据是交互自己带的工具调用号（桥从 tool_execution_start 取的真号，不是工具名 ——
 * 名字对不上任何一次具体调用）。号对不上任何一页时退回尾部：位置差一点，题还在。
 *
 * 待答的不在这里：它得留在活动段尾（timeline-queries 从 active.items 里找它，
 * 输入框那张卡靠这一条挂出来），而且它本来就不上屏（renderable 的 question 分支）。
 *
 * 页按基础页身份记账：sealed 段一旦封口就不再改写，presentation 的 PREFIX/SEGMENTS
 * 全靠页引用稳定（与 wrappedPage 同一条规矩）。命中判据是页身份 + 锚进来的那几条。
 */
const ANCHORED_PAGES = new WeakMap<
  TurnPage,
  { readonly held: readonly TranscriptInteraction[]; page: TurnPage }
>()

function anchoredPage(page: TurnPage, held: readonly TranscriptInteraction[]): TurnPage {
  const kept = ANCHORED_PAGES.get(page)

  if (
    kept !== undefined &&
    kept.held.length === held.length &&
    kept.held.every((interaction, index) => interaction === held[index])
  ) {
    return kept.page
  }

  const items = [...page.items]

  for (const interaction of held) {
    const after = items.findIndex(
      (item) => item.type === 'tool_call' && item.toolCallId === interaction.toolCallId,
    )

    if (after < 0) {
      continue
    }

    items.splice(after + 1, 0, interactionOf(interaction, page.turn, 0))
  }

  const fresh = { ...page, items }
  ANCHORED_PAGES.set(page, { held, page: fresh })

  return fresh
}

/**
 * 把已结的题插进它那一次调用后面，交出改过的页与「仍然要挂尾部」的那几条。
 *
 * 只认提问：审批恒不上屏（renderable 的 permission 分支），而它的 toolCallId 是工具名，
 * 锚上去只会锚到别人的调用上。
 */
function anchorQuestions(
  pages: readonly TurnPage[],
  interactions: AgentTranscriptSnapshot['interactions'],
): { readonly pages: readonly TurnPage[]; readonly tail: readonly TranscriptInteraction[] } {
  const anchored = new Map<number, TranscriptInteraction[]>()
  const tail: TranscriptInteraction[] = []

  for (const interaction of interactions) {
    if (interaction.interactionKind !== 'question' || interaction.state === 'pending') {
      tail.push(interaction)

      continue
    }

    const at = pages.findIndex((page) =>
      page.items.some(
        (item) => item.type === 'tool_call' && item.toolCallId === interaction.toolCallId,
      ),
    )

    if (at < 0) {
      tail.push(interaction)

      continue
    }

    const held = anchored.get(at)

    if (held === undefined) {
      anchored.set(at, [interaction])
    } else {
      held.push(interaction)
    }
  }

  if (anchored.size === 0) {
    return { pages, tail }
  }

  const next = [...pages]

  for (const [at, held] of anchored) {
    const page = next[at]

    if (page !== undefined) {
      next[at] = anchoredPage(page, held)
    }
  }

  return { pages: next, tail }
}

/*
 * 待答的审批与提问挂在活动段尾部；压缩那一条也在这里 —— 它不绑 turn
 * （agent 压缩的是上下文，不是某一轮），所以没有自己的页可挂。
 */
const tailOf = (
  pages: readonly TurnPage[],
  interactions: readonly TranscriptInteraction[],
  items: AgentTranscriptSnapshot['items'],
): TurnPage => {
  const held = pages.at(-1)
  const marks = compactionMarks(items)

  if (held === undefined) {
    return {
      turn: 0,
      items: [
        ...marks.map((mark) => compactionOf(mark, 0)),
        ...interactions.map((interaction) => interactionOf(interaction, 0, 0)),
      ],
    }
  }
  return {
    ...held,
    items: [
      ...held.items,
      ...marks.map((mark) => compactionOf(mark, held.turn)),
      ...interactions.map((interaction) => interactionOf(interaction, held.turn, 0)),
    ],
  }
}

/*
 * 上下文压缩那一条：agent 自己报的，落在标记上。
 *
 * 判据是 marker 名（`compaction`，见 packages/transcript 的 KNOWN_MARKERS）。
 * payload 由桥按 agent 自己的事件填（它知道那次压缩是为什么、成没成）；
 * 这里只把 payload 读成产品那一格，读不出的格子如实缺席 —— 渲染器本来就按
 * 缺席退成一句没有数字的话，编一个数比不显示更坏。
 */
function compactionMarks(items: AgentTranscriptSnapshot['items']): readonly TranscriptMarker[] {
  return items.filter(
    (item): item is TranscriptMarker => item.kind === 'marker' && item.marker === 'compaction',
  )
}

function compactionOf(mark: TranscriptMarker, turn: number): CompactionTimelineItem {
  const payload =
    typeof mark.payload === 'object' && mark.payload !== null
      ? (mark.payload as Record<string, unknown>)
      : {}

  const state = compactionStateOf(payload['state'])
  const trigger = payload['trigger']
  const instruction = payload['instruction']
  const tokensBefore = countOf(payload['tokensBefore'])
  const tokensAfter = countOf(payload['tokensAfter'])

  return {
    type: 'compaction',
    id: mark.markerId,
    turn,
    at: timeOf(mark.at) ?? 0,
    agentId: 'main',
    state,
    ...(trigger === 'manual' || trigger === 'auto' ? { trigger } : {}),
    ...(typeof instruction === 'string' && instruction !== '' ? { instruction } : {}),
    ...(tokensBefore === undefined ? {} : { tokensBefore }),
    ...(tokensAfter === undefined ? {} : { tokensAfter }),
  }
}

/** 认不出的状态按「正在跑」处理：报完成会把一次没成的压缩说成成了。 */
function compactionStateOf(value: unknown): CompactionState {
  return value === 'blocked' || value === 'cancelled' || value === 'completed' ? value : 'running'
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

const phaseOf = (snapshot: AgentTranscriptSnapshot, last: TranscriptTurn | undefined) => {
  if (!snapshot.interactions.some((item) => item.state === 'pending')) {
    if (snapshot.prompts.some((prompt) => prompt.status === 'running')) {
      return 'running'
    }
    if (
      snapshot.prompts.some((prompt) => prompt.status === 'queued' || prompt.status === 'blocked')
    ) {
      return 'submitted'
    }
    return last === undefined ? 'idle' : statusOf(last.state)
  }
  const approval = snapshot.interactions.some(
    (item) => item.state === 'pending' && item.interactionKind === 'approval',
  )
  return approval ? 'awaiting_permission' : 'awaiting_question'
}

type TurnFact = { opensWithAnchor: boolean; anchors: number | null }

/*
 * 段投影按 step 对象身份记账：上游 reducer 只把真改动的那一个 step 换成新对象，其余原样
 * 复用，所以流式期间没动过的段整段复用 —— 段里的帧、工具入参 JSON、工具视图都不必每帧重算。
 * 键是 step 自身，随它一起被回收，不跨对话累积。
 *
 * ordinal 与兜底时间戳必须在判据里：turn 对象每帧都换，而这里是按 step 复用，只有把
 * 从 turn 读来的那两个数一起比过，复用才是真等价。
 */
interface StepFrames {
  readonly ordinal: number
  readonly fallback: number
  readonly items: readonly TimelineItem[]
  readonly userAnchors: number | null
}

const STEP_FRAMES = new WeakMap<TranscriptTurn['steps'][number], StepFrames>()

/* 锚点数相加：null 是「说不清」，一沾就整轮说不清。 */
const addAnchors = (left: number | null, right: number | null): number | null =>
  left === null || right === null ? null : left + right

function projectStep(
  step: TranscriptTurn['steps'][number],
  ordinal: number,
  fallback: number,
): StepFrames {
  const held = STEP_FRAMES.get(step)
  if (held !== undefined && held.ordinal === ordinal && held.fallback === fallback) {
    return held
  }
  const items: TimelineItem[] = []
  let userAnchors: number | null = 0
  for (const frame of step.frames) {
    const projected = frameOf(frame, ordinal, at(step.startedAt) || fallback)
    if (projected !== null) {
      items.push(projected)
    }
    if (frame.kind === 'text' && frame.role === 'user') {
      userAnchors = addAnchors(userAnchors, sourceOfFrame(frame).anchors)
    }
  }
  const fresh: StepFrames = { ordinal, fallback, items, userAnchors }
  STEP_FRAMES.set(step, fresh)
  return fresh
}

function framesOf(
  turn: TranscriptTurn,
  stamp: number,
): {
  items: readonly TimelineItem[]
  userAnchors: number | null
} {
  const items: TimelineItem[] = []
  let userAnchors: number | null = 0
  for (const step of turn.steps) {
    const projected = projectStep(step, turn.ordinal, stamp)
    items.push(...projected.items)
    userAnchors = addAnchors(userAnchors, projected.userAnchors)
  }
  return { items, userAnchors }
}

// 按 turn 对象身份记账：上游 reducer 结构共享，没变的 turn 复用上次投影。
// 带附件的 turn 还依赖两本外部集合（attachments、media），判据跟着它们走。
const TURN_PROJECTIONS = new WeakMap<
  TranscriptTurn,
  {
    readonly sources: readonly (TranscriptAttachment | undefined)[]
    readonly media: ReadonlyMap<string, string>
    page: TurnPage
    fact: TurnFact
    span: TurnSpan
  }
>()

function sourcesOf(
  turn: TranscriptTurn,
  index: ReadonlyMap<string, TranscriptAttachment>,
): readonly (TranscriptAttachment | undefined)[] {
  const ids = turn.attachmentIds
  return ids === undefined || ids.length === 0 ? [] : ids.map((id) => index.get(id))
}

const sameSources = (
  left: readonly (TranscriptAttachment | undefined)[],
  right: readonly (TranscriptAttachment | undefined)[],
): boolean => left.length === right.length && left.every((value, at) => value === right[at])

/** turn 上报的错去重后追加到条目尾；没有就不加。 */
function errorItemOf(turn: TranscriptTurn, items: TimelineItem[], stamp: number): void {
  if (
    turn.error === undefined ||
    turn.error.length === 0 ||
    items.some((item) => item.type === 'error' && item.message === turn.error)
  ) {
    return
  }
  items.push({
    type: 'error',
    id: `turn-error:${turn.turnId}`,
    turn: turn.ordinal,
    at: timeOf(turn.endedAt) ?? stamp,
    message: turn.error,
  })
}

function projectTurn(
  turn: TranscriptTurn,
  index: ReadonlyMap<string, TranscriptAttachment>,
  media: ReadonlyMap<string, string>,
): {
  page: TurnPage
  fact: TurnFact
  span: TurnSpan
} {
  const cached = TURN_PROJECTIONS.get(turn)

  const usesAttachments = (turn.attachmentIds?.length ?? 0) > 0
  if (
    cached !== undefined &&
    (!usesAttachments ||
      (cached.media === media && sameSources(cached.sources, sourcesOf(turn, index))))
  ) {
    return cached
  }

  const stamp = at(turn.startedAt)
  const source = sourceOfTurn(turn)
  const hasInput = turn.prompt !== undefined || (turn.attachmentIds?.length ?? 0) > 0
  const opening = hasInput ? source.anchors : source.isUser ? null : 0
  const attached = hasInput ? attachmentsOfTurn(turn, index, media) : NO_TURN_ATTACHMENTS
  const opened = hasInput
    ? inputItem(
        source,
        turn.triggerPromptId ?? turn.turnId,
        turn.ordinal,
        stamp,
        turn.prompt ?? '',
        skillNamesOf(turn.origin.payload),
        attached,
      )
    : null
  const frames = framesOf(turn, stamp)
  const anchors =
    frames.userAnchors === null || opening === null ? null : opening + frames.userAnchors
  const items = [...(opened === null ? [] : [opened]), ...frames.items]
  errorItemOf(turn, items, stamp)
  const projected = {
    sources: sourcesOf(turn, index),
    media,
    page: {
      turn: turn.ordinal,
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      items,
    },
    fact: { opensWithAnchor: opening === 1, anchors },
    span: spanOf(turn, turn.ordinal),
  }
  TURN_PROJECTIONS.set(turn, projected)

  return projected
}

// 包裹页按基础页身份记账：run 字段不变时复用，否则 presentation 层的页缓存永远不命中。
const WRAPPED_PAGES = new WeakMap<TurnPage, TurnPage>()

function wrappedPage(page: TurnPage, run: NonNullable<TurnPage['run']>): TurnPage {
  const wrapped = WRAPPED_PAGES.get(page)
  if (
    wrapped?.run !== undefined &&
    wrapped.run.settled === run.settled &&
    wrapped.run.undoCount === run.undoCount &&
    wrapped.run.forkUnavailableReason === run.forkUnavailableReason
  ) {
    return wrapped
  }
  const fresh = { ...page, run }
  WRAPPED_PAGES.set(page, fresh)
  return fresh
}

function runBoundariesOf(
  pages: readonly TurnPage[],
  facts: readonly TurnFact[],
  items: AgentTranscriptSnapshot['items'],
  busy: boolean,
): TurnPage[] {
  const result = [...pages]
  let suffixAnchors = 0
  let nextOpensWithAnchor = true
  let uncertainty: string | null = null
  let runIndex = result.length - 1
  for (const item of items.toReversed()) {
    if (item.kind !== 'turn') {
      uncertainty = '包含压缩或其他边界标记，无法证明精确截断。'
      continue
    }
    const page = result[runIndex]
    const fact = facts[runIndex]
    if (page === undefined || fact === undefined) {
      throw new Error('Transcript run projection is incomplete.')
    }
    const settled = isSettled(item.state)
    const reason =
      busy || !settled
        ? '会话仍在运行或等待输入，暂不可分叉。'
        : (uncertainty ??
          (nextOpensWithAnchor ? null : '下一段不从用户撤销锚点开始，无法精确截到此处。'))
    result[runIndex] = wrappedPage(page, {
      settled,
      undoCount: reason === null ? suffixAnchors : null,
      forkUnavailableReason: reason,
    })
    if (fact.anchors === null) {
      uncertainty = '来源或撤销锚点信息不足，不能可靠计算分叉位置。'
    } else {
      suffixAnchors += fact.anchors
    }
    // conversation-runtime ForkThread.drop_turns is u32.
    if (suffixAnchors > 0xffff_ffff) {
      uncertainty = '撤销锚点计数超出平台支持范围。'
    }
    if (item.origin.kind === 'compaction') {
      uncertainty = '不能跨越上下文压缩边界分叉。'
    }
    nextOpensWithAnchor = fact.opensWithAnchor
    runIndex -= 1
  }
  return result
}

export function projectTranscript(
  snapshot: AgentTranscriptSnapshot,
  media: ReadonlyMap<string, string> = EMPTY_MEDIA,
): TimelineState {
  const turns = snapshot.items.filter((item): item is TranscriptTurn => item.kind === 'turn')
  const status = phaseOf(snapshot, turns.at(-1))
  const busy =
    isInFlight(status) ||
    turns.some((turn) => !isSettled(turn.state)) ||
    (snapshot.meta.activity !== undefined && snapshot.meta.activity !== 'idle')
  const attachmentIndex =
    turns.some((turn) => (turn.attachmentIds?.length ?? 0) > 0) && snapshot.attachments.length > 0
      ? new Map(snapshot.attachments.map((attachment) => [attachment.attachmentId, attachment]))
      : EMPTY_INDEX
  const pages: TurnPage[] = []
  const spans: TurnSpan[] = []
  const facts: TurnFact[] = []
  for (const turn of turns) {
    const projected = projectTurn(turn, attachmentIndex, media)
    pages.push(projected.page)
    facts.push(projected.fact)
    spans.push(projected.span)
  }
  const marked = runBoundariesOf(pages, facts, snapshot.items, busy)
  const placed = anchorQuestions(marked, snapshot.interactions)
  return {
    status,
    backgroundTasks: snapshot.tasks
      .map(backgroundOf)
      .filter((item): item is BackgroundTaskItem => item !== null),
    subagents: snapshot.tasks.map(subagentOf).filter((item): item is SubagentItem => item !== null),
    sealed: stableSealed(placed.pages),
    active: tailOf(placed.pages, placed.tail, snapshot.items),
    lastSeq: 0,
    spans,
  }
}

/*
 * sealed 引用稳定化：presentation 层的 PREFIX WeakMap 以 sealed 数组为键，
 * 每次 slice 都换新引用会让缓存永远不命中。元素引用已由 TURN_PROJECTIONS +
 * WRAPPED_PAGES 保证稳定，所以只需比较长度与逐元素引用即可复用上一次数组。
 */
const EMPTY_SEALED: readonly TurnPage[] = []
let sealedCache: readonly TurnPage[] = EMPTY_SEALED

function stableSealed(marked: readonly TurnPage[]): readonly TurnPage[] {
  const len = marked.length - 1
  if (len <= 0) {
    sealedCache = EMPTY_SEALED
    return EMPTY_SEALED
  }
  if (sealedCache.length === len) {
    let same = true
    for (let i = 0; i < len; i += 1) {
      if (sealedCache[i] !== marked[i]) {
        same = false
        break
      }
    }
    if (same) {
      return sealedCache
    }
  }
  const fresh = marked.slice(0, len)
  sealedCache = fresh
  return fresh
}

/*
 * 目录标记按 turn 对象身份记账，与同文件的 TURN_PROJECTIONS / WRAPPED_PAGES 同一形态。
 *
 * 不能用模块级 turnId 强引用表：turnId 在每条对话、每个子代理频道里都从 t1 重新编，
 * 按它记账会把 A 的标记发给 B（题面与回复一起串）；reset 换掉正文而号没换时同样会
 * 认错。而且那张表永不释放 —— 开过的对话越多久占越大。turn 对象是每条对话各自持有
 * 的，WeakMap 因此既认得出归属，也随对话一起被回收。
 *
 * 记账里还要存「算出这个 reply 时那一轮封口没有」：未封口时复用（minimap 不需要逐
 * token 刷新），一变成封口就必须重算一次 —— 封口前看到的是半截正文，拿它当最终回复
 * 是错的。数组也做引用稳定化，避免 minimap memo 100% 失效。
 */
const OUTLINE_MARKS = new WeakMap<
  TranscriptTurn,
  { readonly sealed: boolean; readonly mark: TurnMark }
>()
let outlineCache: readonly TurnMark[] = []

/*
 * 逐段算好的正文。判据是段自己的身份：流式期间上游只替换真动了的那一段，其余段按
 * 引用留用，于是只有正在吐字的那一段要重新拼 —— 整轮重拼是「按 turn 记账」要付的那
 * 笔钱，而它随轮长线性增长。
 */
const STEP_REPLIES = new WeakMap<TranscriptTurn['steps'][number], string>()

function replyOfStep(step: TranscriptTurn['steps'][number]): string {
  const held = STEP_REPLIES.get(step)
  if (held !== undefined) {
    return held
  }
  const joined = step.frames
    .filter((frame) => frame.kind === 'text' && frame.role === 'assistant')
    .map((frame) => frame.text)
    .join('\n\n')
  STEP_REPLIES.set(step, joined)
  return joined
}

function replyOf(turn: TranscriptTurn): string | null {
  const said: string[] = []
  for (const step of turn.steps) {
    const text = replyOfStep(step)
    if (text !== '') {
      said.push(text)
    }
  }
  return said.length === 0 ? null : said.join('\n\n')
}

const sameMark = (left: TurnMark, right: TurnMark): boolean =>
  left.turnId === right.turnId &&
  left.admissionId === right.admissionId &&
  left.prompt === right.prompt &&
  left.reply === right.reply

/* 一轮的标记：同一个 turn 对象上封口前后各算一次，之后原样交回。 */
function markOf(turn: TranscriptTurn): TurnMark {
  const held = OUTLINE_MARKS.get(turn)
  const sealed = isSettled(turn.state)

  // 已经按封口算过，或这一轮本来就还没封口 → 复用。
  if (held !== undefined && (held.sealed || !sealed)) {
    return held.mark
  }

  const computed: TurnMark = {
    turnId: turn.turnId,
    admissionId: turn.triggerPromptId ?? turn.turnId,
    prompt: withoutKimiAttachmentNotices(turn.prompt ?? ''),
    reply: replyOf(turn),
  }
  const mark = held !== undefined && sameMark(held.mark, computed) ? held.mark : computed
  OUTLINE_MARKS.set(turn, { mark, sealed })
  return mark
}

const sameOutline = (left: readonly TurnMark[], right: readonly TurnMark[]): boolean =>
  left.length === right.length && left.every((mark, at) => mark === right[at])

export const outlineOf = (snapshot: AgentTranscriptSnapshot): readonly TurnMark[] => {
  const marks: TurnMark[] = []

  for (const item of snapshot.items) {
    if (item.kind === 'turn' && sourceOfTurn(item).isUser) {
      marks.push(markOf(item))
    }
  }

  /* 引用稳定化：元素全同则交回上次那个数组，minimap 的 memo 才稳得住。 */
  if (sameOutline(marks, outlineCache)) {
    return outlineCache
  }

  outlineCache = marks
  return marks
}

export function knownPromptIds(snapshot: AgentTranscriptSnapshot): ReadonlySet<string> {
  const result = new Set(snapshot.prompts.map((prompt) => prompt.promptId))
  for (const item of snapshot.items) {
    if (item.kind === 'turn' && item.triggerPromptId !== undefined) {
      result.add(item.triggerPromptId)
    }
  }
  return result
}

export function promptOutcome(
  snapshot: AgentTranscriptSnapshot,
  promptId: string,
): 'completed' | 'cancelled' | 'failed' | null {
  const prompt = snapshot.prompts.find((entry) => entry.promptId === promptId)
  if (prompt !== undefined) {
    switch (prompt.status) {
      case 'completed':
        return 'completed'
      case 'aborted':
        return 'cancelled'
      case 'failed':
        return 'failed'
      default:
        return null
    }
  }
  const turn = snapshot.items.findLast(
    (item) => item.kind === 'turn' && item.triggerPromptId === promptId,
  )
  if (turn?.kind !== 'turn') {
    return null
  }
  switch (turn.state) {
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
    default:
      return null
  }
}
