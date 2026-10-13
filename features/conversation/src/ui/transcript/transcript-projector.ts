import { invariant } from '@poietica/foundation'
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
  PlanItem,
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
import { ompToolView } from '../timeline/tools/omp-tool-view'
import { describeTool } from '../timeline/tools/tool-vocabulary'

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
  typeof value === 'string' && value.length > 0 ? [{ type: 'content', content: { type: 'text', text: value } }] : []

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

const EMPTY_INDEX: ReadonlyMap<string, TranscriptAttachment> = new Map()

/* 图片只有一种来源：`attachment.upsert` 里内联的 data URL。给不出 source 就返回 undefined，不排一次取字节。 */
function imageUrlOf(attachment: TranscriptAttachment): string | undefined {
  const { source } = attachment
  return source?.kind === 'url' ? source.url : undefined
}

function attachmentsOfTurn(turn: TranscriptTurn, index: ReadonlyMap<string, TranscriptAttachment>): TurnAttachments {
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
    if (attachment.mediaType.startsWith('image/')) {
      const url = imageUrlOf(attachment)
      images.push(url === undefined ? { pending: true } : { url })
    } else {
      const name = attachment.name ?? '附件'
      files.push({ name, meta: fileMetaLabel(name, attachment.size) })
    }
  }
  return { images, files }
}

// 正文里混着给模型看的附件句子，在这里摘掉：只有真用户输入才成行。
function inputItem(
  source: InputSource,
  id: string,
  turn: number,
  stamp: number,
  text: string,
  skills: readonly string[],
  attached: TurnAttachments = NO_TURN_ATTACHMENTS,
  clientTurnId?: string,
): UserMessageItem | null {
  return source.isUser
    ? {
        type: 'user_message',
        id,
        turn,
        at: stamp,
        text: text,
        ...(clientTurnId === undefined ? {} : { clientTurnId }),
        ...(attached.images.length === 0 ? {} : { images: attached.images }),
        ...(attached.files.length === 0 ? {} : { files: attached.files }),
        ...(skills.length === 0 ? {} : { skills }),
      }
    : null
}

const isSettled = (state: TranscriptTurn['state']): boolean =>
  state === 'completed' || state === 'cancelled' || state === 'failed'

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
  return inputItem(sourceOfFrame(frame), frame.frameId, turn, stamp, frame.text, skillNamesOf(frame.origin))
}

function toolFrameOf(
  frame: Extract<TranscriptFrame, { kind: 'tool' }>,
  turn: number,
  stamp: number,
): ToolCallTimelineItem {
  const view = ompToolView(frame.name, frame.input, frame.output, frame.error, frame.intent)
  // 只在 view 不认识该工具或 subject 为空时才要 describeTool，避免 15k 次无用 Reflect.get。
  const tool = view.known && view.subject ? undefined : describeTool(frame.input)
  return {
    type: 'tool_call',
    id: frame.frameId,
    turn,
    at: stamp,
    toolCallId: frame.toolCallId,
    title: frame.name,
    // 认名字要认得「真正在跑的那一个」：write xd://<工具> 跑的是被挂载的设备；title 保持帧上的名字。
    invokedTool: view.known && view.invokedTool !== '' ? view.invokedTool : frame.name,
    scheme: view.known ? view.scheme : '',
    kind: view.known ? view.kind : (tool?.kind ?? 'other'),
    headline: view.headline,
    subject: view.subject || (tool?.subject ?? ''),
    shape: view.shape,
    ...(view.background ? { isBackground: true as const } : {}),
    status: frame.state === 'running' ? 'in_progress' : frame.state === 'error' ? 'failed' : 'completed',
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
      /* info 在本产品里没有样子：引擎侧已经不发了。 */
      return frame.level === 'info'
        ? null
        : { type: 'error', id: frame.frameId, turn, at: stamp, message: frame.message, level: frame.level }
    case 'tool':
      return toolFrameOf(frame, turn, stamp)
  }
}
const approvalDecision = (state: TranscriptInteraction['state']) =>
  state === 'approved' ? 'approved' : state === 'rejected' ? 'rejected' : 'cancelled'
const questionOutcome = (state: TranscriptInteraction['state']) =>
  state === 'answered' ? 'answered' : state === 'dismissed' ? 'dismissed' : 'cancelled'

/** 引擎的三档答复映射成 transcript 的四档，这里再翻回卡片自己的词表。 */
function planResolutionOf(interaction: TranscriptInteraction): NonNullable<PlanItem['resolution']> {
  const response = typeof interaction.response === 'object' && interaction.response !== null ? interaction.response : {}
  const feedback = stringField(response, 'feedback')
  if (interaction.state === 'approved') return { decision: 'approved' }
  if (interaction.state === 'answered') return { decision: 'revise', feedback: feedback ?? '' }
  if (interaction.state === 'cancelled' || interaction.state === 'dismissed') return { decision: 'cancelled' }
  return { decision: 'rejected' }
}

/** 缺席 / 类型不符都返回 null —— 不编一个空串当有值。 */
function stringField(source: object, key: string): string | null {
  const value = Reflect.get(source, key)
  return typeof value === 'string' ? value : null
}

function approvalFields(request: unknown): { toolName: string; detail: string | null } {
  if (typeof request !== 'object' || request === null) {
    return { toolName: '', detail: null }
  }
  /* 线上字段名就是 toolName，别跟着改。 */
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
): PermissionItem | PlanItem | QuestionTimelineItem {
  const resolved = interaction.state !== 'pending'
  /* 卡片的正文与路径都在 `request` 里。判据照**放宽后**的类型读：`plan` 是线上形状那一层放出来的。 */
  const kind: string = interaction.interactionKind
  if (kind === 'plan') {
    const request = typeof interaction.request === 'object' && interaction.request !== null ? interaction.request : {}
    const resolution = resolved ? planResolutionOf(interaction) : undefined
    return {
      type: 'plan',
      id: interaction.interactionId,
      turn,
      at: stamp,
      requestId: interaction.interactionId,
      title: stringField(request, 'title') ?? '计划',
      planFilePath: stringField(request, 'planFilePath') ?? '',
      planMarkdown: stringField(request, 'planMarkdown') ?? '',
      ...(resolution === undefined ? {} : { resolution }),
    }
  }
  if (interaction.interactionKind === 'approval') {
    const { toolName, detail } = approvalFields(interaction.request)

    /*
     * 主语取上游算好的那一段（`Command: rm -rf …` 这类），不是工具名：判据是「要不要让它做这件事」。用 headline 而不是 subject：headline 是多行原文，sayToolLine 只截第一行。
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
  const request = typeof interaction.request === 'object' && interaction.request !== null ? interaction.request : {}
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
 * 现场挂在 `answers` 上（键是题号），回放时本机账本存的是 `[{questionId, answer}]`。读不出来就给空表 —— 题面还在，比编一个「答过了」强。
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

/** 判别式与分支名是协议取值域，别改。 */
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

/** 上游每题一格备注，产品整组一格，所以取那一格。 */
function noteOf(response: unknown): string {
  if (typeof response !== 'object' || response === null) {
    return ''
  }

  const note = Reflect.get(response, 'note')

  return typeof note === 'string' ? note : ''
}
function labelOf(item: QuestionItem, optionId: string): string {
  const option = item.options.find((candidate) => candidate.id === optionId)

  return option === undefined ? optionId : option.label
}

function describeAnswer(item: QuestionItem, answer: QuestionChoice): string {
  switch (answer.kind) {
    case 'single':
      return labelOf(item, answer.optionId)
    case 'multi':
      return answer.optionIds.map((optionId) => labelOf(item, optionId)).join('、')
    case 'other':
      return answer.text
    case 'multi_with_other':
      return [...answer.optionIds.map((optionId) => labelOf(item, optionId)), answer.otherText].join('、')
    case 'skipped':
      return '跳过'
  }
}

/*
 * 题面在上、答复在下，长在发起它的那次 ask 调用里。一道都读不出时交回 null —— 那句原始产出虽然朴素，但它是真的。
 */
const UNANSWERED = {
  cancelled: '这一轮被取消，这组题没有等到答复。',
  dismissed: '这组题被撤下了。',
  undelivered: '答复没能送到 agent 手里。',
} as const

function answersBodyOf(interaction: TranscriptInteraction): string | null {
  const request = typeof interaction.request === 'object' && interaction.request !== null ? interaction.request : {}
  const questions = (
    Array.isArray(Reflect.get(request, 'questions')) ? Reflect.get(request, 'questions') : []
  ) as readonly QuestionItem[]

  if (questions.length === 0) {
    return null
  }

  const outcome = questionOutcome(interaction.state)
  const answers = answersOf(interaction.response)

  if (outcome === 'answered' && questions.every((question) => answers[question.id] === undefined)) {
    return null
  }

  const note = noteOf(interaction.response)
  const last = questions.length - 1
  const blocks: string[] = []

  for (const [index, question] of questions.entries()) {
    const answer = answers[question.id]
    const notes: string[] = []

    if (outcome !== 'answered') {
      notes.push(UNANSWERED[outcome])
    }
    if (index === last && note.length > 0) {
      notes.push(note)
    }

    blocks.push(question.question)

    if (answer !== undefined) {
      blocks.push('', `**${describeAnswer(question, answer)}**`)
    }
    if (notes.length > 0) {
      blocks.push('', notes.join(' '))
    }

    blocks.push('')
  }

  return blocks.join('\n').trim()
}

const backgroundOf = (task: TranscriptTask): BackgroundTaskItem | null => {
  /* 子代理不走这一格（见 subagentOf）。`detached` 只说明「父轮不等它」，不说明它是什么。 */
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
 * 判据是 `kind === 'subagent'`，不是 `detached` —— 同步子代理同样要出现在「智能体」那一节。按 detached 分派正是此前那条缺陷。
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
    ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(lastFrameAt === undefined ? {} : { lastFrameAt }),
  }
}

/*
 * 判据是交互自带的工具调用号（桥从 tool_execution_start 取的真号，不是工具名）。号对不上任何一页时这一组就不上屏。待答的不在这里：它得留在活动段尾。
 * 页按基础页身份记账：sealed 段一旦封口就不再改写，presentation 的 PREFIX/SEGMENTS 全靠页引用稳定。
 */
const ANCHORED_PAGES = new WeakMap<TurnPage, { readonly held: readonly TranscriptInteraction[]; page: TurnPage }>()

function askIndexes(items: readonly TimelineItem[], toolCallId: string): readonly number[] {
  const exact: number[] = []
  const byName: number[] = []

  for (const [at, item] of items.entries()) {
    if (item.type !== 'tool_call') {
      continue
    }
    if (item.toolCallId === toolCallId) {
      exact.push(at)
    } else if (item.title === toolCallId) {
      byName.push(at)
    }
  }

  return exact.length > 0 ? exact : byName
}

/* 首选真调用号；回放时号退成了工具名，那就按工具名找**下一条还没被认领的** —— 一轮里问过两次时，两组答复各归各的调用。 */
function askAt(items: readonly TimelineItem[], toolCallId: string, used: Set<number>): number {
  for (const at of askIndexes(items, toolCallId)) {
    if (!used.has(at)) {
      return at
    }
  }

  return -1
}

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
  const used = new Set<number>()

  for (const interaction of held) {
    const at = askAt(items, interaction.toolCallId ?? '', used)
    const item = at < 0 ? undefined : items[at]

    if (item?.type !== 'tool_call') {
      continue
    }

    used.add(at)

    const body = answersBodyOf(interaction)

    if (body !== null) {
      items[at] = { ...item, content: [{ type: 'prose', text: body }] }
    }
  }

  const fresh = { ...page, items }
  ANCHORED_PAGES.set(page, { held, page: fresh })

  return fresh
}

/** 把已结的题的答复折进发起它的那一次调用。只认提问：审批恒不上屏，而它的 toolCallId 是工具名，锚上去只会锚到别人的调用上。 */
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

    const at = pages.findIndex((page) => askIndexes(page.items, interaction.toolCallId ?? '').length > 0)

    if (at < 0) {
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

/* 待答的审批与提问挂在活动段尾部；压缩那一条也在这里 —— 它不绑 turn。 */
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
 * agent 自己报的，落在标记上，判据是 marker 名（`compaction`）。读不出的格子如实缺席 —— 编一个数更坏。
 */
function compactionMarks(items: AgentTranscriptSnapshot['items']): readonly TranscriptMarker[] {
  return items.filter((item): item is TranscriptMarker => item.kind === 'marker' && item.marker === 'compaction')
}

function compactionOf(mark: TranscriptMarker, turn: number): CompactionTimelineItem {
  const payload =
    typeof mark.payload === 'object' && mark.payload !== null ? (mark.payload as Record<string, unknown>) : {}

  const state = compactionStateOf(payload.state)
  const trigger = payload.trigger
  const instruction = payload.instruction
  const tokensBefore = countOf(payload.tokensBefore)
  const tokensAfter = countOf(payload.tokensAfter)

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
    if (snapshot.prompts.some((prompt) => prompt.status === 'queued' || prompt.status === 'blocked')) {
      return 'submitted'
    }
    return last === undefined ? 'idle' : statusOf(last.state)
  }
  const approval = snapshot.interactions.some((item) => item.state === 'pending' && item.interactionKind === 'approval')
  if (approval) return 'awaiting_permission'
  /* 计划是一道自己的闸：它把「继续执行」拦在批准之前，与审批 / 提问并列。 */
  const kinded = snapshot.interactions.map((item) => item.interactionKind as string)
  if (snapshot.interactions.some((item, index) => item.state === 'pending' && kinded[index] === 'plan')) {
    return 'awaiting_plan'
  }
  return 'awaiting_question'
}

type TurnFact = { opensWithAnchor: boolean; anchors: number | null }

/*
 * 上游 reducer 只把真改动的那一个 step 换成新对象，其余复用。ordinal 与兜底时间戳必须在判据里：turn 对象每帧都换。
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

function projectStep(step: TranscriptTurn['steps'][number], ordinal: number, fallback: number): StepFrames {
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
const TURN_PROJECTIONS = new WeakMap<
  TranscriptTurn,
  {
    readonly sources: readonly (TranscriptAttachment | undefined)[]
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
    level: 'error',
  })
}

function projectTurn(
  turn: TranscriptTurn,
  index: ReadonlyMap<string, TranscriptAttachment>,
): {
  page: TurnPage
  fact: TurnFact
  span: TurnSpan
} {
  const cached = TURN_PROJECTIONS.get(turn)

  const usesAttachments = (turn.attachmentIds?.length ?? 0) > 0
  if (cached !== undefined && (!usesAttachments || sameSources(cached.sources, sourcesOf(turn, index)))) {
    return cached
  }

  const stamp = at(turn.startedAt)
  const source = sourceOfTurn(turn)
  const hasInput = turn.prompt !== undefined || (turn.attachmentIds?.length ?? 0) > 0
  const opening = hasInput ? source.anchors : source.isUser ? null : 0
  const attached = hasInput ? attachmentsOfTurn(turn, index) : NO_TURN_ATTACHMENTS
  const opened = hasInput
    ? inputItem(
        source,
        turn.triggerPromptId ?? turn.turnId,
        turn.ordinal,
        stamp,
        turn.prompt ?? '',
        skillNamesOf(turn.origin.payload),
        attached,
        (turn as { readonly clientTurnId?: string }).clientTurnId,
      )
    : null
  const frames = framesOf(turn, stamp)
  const anchors = frames.userAnchors === null || opening === null ? null : opening + frames.userAnchors
  const items = [...(opened === null ? [] : [opened]), ...frames.items]
  errorItemOf(turn, items, stamp)
  const projected = {
    sources: sourcesOf(turn, index),
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

// 包裹页按基础页身份记账：run 字段不变时复用，否则 presentation 的页缓存永远不命中。
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
      invariant(false, 'Transcript run projection is incomplete.')
    }
    const settled = isSettled(item.state)
    const reason =
      busy || !settled
        ? '会话仍在运行或等待输入，暂不可分叉。'
        : (uncertainty ?? (nextOpensWithAnchor ? null : '下一段不从用户撤销锚点开始，无法精确截到此处。'))
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
    // ForkThread.drop_turns 是 u32。
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

/**
 * 必须按通道各一份（由调用方持有、随通道一起丢）—— 模块级只放一份的话，两条通道交替发布就互相覆盖，presentation 的前缀缓存与 minimap 的 memo 全部落空。
 */
export interface ProjectionMemo {
  sealed: readonly TurnPage[]
  outline: readonly TurnMark[]
}

const EMPTY_SEALED: readonly TurnPage[] = []
const EMPTY_OUTLINE: readonly TurnMark[] = []

export function createProjectionMemo(): ProjectionMemo {
  return { sealed: EMPTY_SEALED, outline: EMPTY_OUTLINE }
}

export function projectTranscript(snapshot: AgentTranscriptSnapshot, memo: ProjectionMemo): TimelineState {
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
    const projected = projectTurn(turn, attachmentIndex)
    pages.push(projected.page)
    facts.push(projected.fact)
    spans.push(projected.span)
  }
  const marked = runBoundariesOf(pages, facts, snapshot.items, busy)
  const placed = anchorQuestions(marked, snapshot.interactions)
  return {
    status,
    backgroundTasks: snapshot.tasks.map(backgroundOf).filter((item): item is BackgroundTaskItem => item !== null),
    subagents: snapshot.tasks.map(subagentOf).filter((item): item is SubagentItem => item !== null),
    sealed: stableSealed(placed.pages, memo),
    active: tailOf(placed.pages, placed.tail, snapshot.items),
    lastSeq: 0,
    spans,
  }
}

/*
 * presentation 层的 PREFIX WeakMap 以 sealed 数组为键，每次 slice 换新引用会让缓存永远不命中。元素引用已由 TURN_PROJECTIONS + WRAPPED_PAGES 保证稳定，只需比较长度与逐元素引用。
 */
function stableSealed(marked: readonly TurnPage[], memo: ProjectionMemo): readonly TurnPage[] {
  const len = marked.length - 1
  if (len <= 0) {
    memo.sealed = EMPTY_SEALED
    return EMPTY_SEALED
  }
  const held = memo.sealed
  if (held.length === len && held.every((page, at) => page === marked[at])) {
    return held
  }
  const fresh = marked.slice(0, len)
  memo.sealed = fresh
  return fresh
}

/*
 * 不能用模块级 turnId 强引用表：turnId 在每条对话、每个子代理频道里都从 t1 重编，按它记账会把 A 的标记发给 B，而且那张表永不释放。
 * 记账里还要存「算出这个 reply 时那一轮封口没有」：封口前看到的是半截正文，拿它当最终回复是错的。
 */
const OUTLINE_MARKS = new WeakMap<TranscriptTurn, { readonly sealed: boolean; readonly mark: TurnMark }>()

/*
 * 判据是段自己的身份：流式期间上游只替换真动了的那一段，于是只有正在吐字的那一段要重新拼。
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

/*
 * 流式每来一批，上游都会把在跑的那一轮换成新的 turn 对象，按对象身份记账因此每批都落空；而上一份目录是**这条通道自己的**，同一个位置上号、题面都对得上就是同一轮。
 */
function carriedMark(turn: TranscriptTurn, previous: TurnMark | undefined): TurnMark | undefined {
  if (previous === undefined || isSettled(turn.state)) {
    return undefined
  }
  const same =
    previous.turnId === turn.turnId &&
    previous.admissionId === (turn.triggerPromptId ?? turn.turnId) &&
    previous.prompt === (turn.prompt ?? '')
  return same ? previous : undefined
}

function markOf(turn: TranscriptTurn, previous: TurnMark | undefined): TurnMark {
  const held = OUTLINE_MARKS.get(turn)
  const sealed = isSettled(turn.state)

  if (held !== undefined && (held.sealed || !sealed)) {
    return held.mark
  }

  const carried = held === undefined ? carriedMark(turn, previous) : undefined
  if (carried !== undefined) {
    OUTLINE_MARKS.set(turn, { mark: carried, sealed: false })
    return carried
  }

  const computed: TurnMark = {
    turnId: turn.turnId,
    admissionId: turn.triggerPromptId ?? turn.turnId,
    prompt: turn.prompt ?? '',
    reply: replyOf(turn),
  }
  const base = held?.mark ?? previous
  const mark = base !== undefined && sameMark(base, computed) ? base : computed
  OUTLINE_MARKS.set(turn, { mark, sealed })
  return mark
}

const sameOutline = (left: readonly TurnMark[], right: readonly TurnMark[]): boolean =>
  left.length === right.length && left.every((mark, at) => mark === right[at])

export const outlineOf = (snapshot: AgentTranscriptSnapshot, memo: ProjectionMemo): readonly TurnMark[] => {
  const previous = memo.outline
  const marks: TurnMark[] = []

  for (const item of snapshot.items) {
    if (item.kind === 'turn' && sourceOfTurn(item).isUser) {
      marks.push(markOf(item, previous[marks.length]))
    }
  }

  if (sameOutline(marks, previous)) {
    return previous
  }

  memo.outline = marks
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
  const turn = snapshot.items.findLast((item) => item.kind === 'turn' && item.triggerPromptId === promptId)
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
