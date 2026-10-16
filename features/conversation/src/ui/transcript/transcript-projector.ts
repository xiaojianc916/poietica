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
  TurnOutcome,
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
}

const USER_INPUT: InputSource = { isUser: true }

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
      return { isUser: originField(origin.payload, 'phase') === 'input' }
    }
    return USER_INPUT
  }
  return { isUser: false }
}

function sourceOfFrame(frame: Extract<TranscriptFrame, { role: 'user' }>): InputSource {
  return frame.origin?.kind === 'user' ? USER_INPUT : { isUser: false }
}

interface TurnAttachments {
  readonly images: MessageImage[]
  readonly files: MessageFile[]
}

const NO_TURN_ATTACHMENTS: TurnAttachments = { images: [], files: [] }

const EMPTY_INDEX: ReadonlyMap<string, TranscriptAttachment> = new Map()
const NO_IDS: readonly string[] = []

/* 图片只有一种来源：`attachment.upsert` 里内联的 data URL。给不出 source 就返回 undefined，不排一次取字节。 */
function imageUrlOf(attachment: TranscriptAttachment): string | undefined {
  const { source } = attachment
  return source?.kind === 'url' ? source.url : undefined
}

/**
 * 一句人话带的附件：轮头（开轮那一句）与插话帧（R-19-1：开着一轮时插进来的那一句）共用这一份。
 * 号在索引里找不到就跳过 —— 附件条目总是先于引用它的轮头 / 帧到达，找不到说明它不归这一页。
 */
function attachmentsOf(
  ids: readonly string[] | undefined,
  index: ReadonlyMap<string, TranscriptAttachment>,
): TurnAttachments {
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

/**
 * 轮的终局 → 封条那一格的三档。`cancelled` 是「人叫停的」，报「已停止」；`failed` 是「它自己坏的」，
 * 报「处理失败」。两者都不折过程：坏在哪比省一屏更重要。未终局返回 undefined（在跑 / 排队）。
 */
function outcomeOf(state: TranscriptTurn['state']): TurnOutcome | undefined {
  if (state === 'completed') {
    return 'completed'
  }

  return state === 'cancelled' ? 'aborted' : state === 'failed' ? 'error' : undefined
}

function textFrameOf(
  frame: Extract<TranscriptFrame, { kind: 'text' }>,
  turn: number,
  stamp: number,
  index: ReadonlyMap<string, TranscriptAttachment>,
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
    attachmentsOf(frame.attachmentIds, index),
  )
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

function frameOf(
  frame: TranscriptFrame,
  turn: number,
  stamp: number,
  index: ReadonlyMap<string, TranscriptAttachment>,
): TimelineItem | null {
  switch (frame.kind) {
    case 'text':
      return textFrameOf(frame, turn, stamp, index)
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

/* 待答的审批与提问挂在活动段尾部。压缩不在这里：它按发生的位置落在各自那一页里（placeCompactions），只有一轮都还没有时才落在这一段。 */
const tailOf = (
  pages: readonly TurnPage[],
  interactions: readonly TranscriptInteraction[],
  items: AgentTranscriptSnapshot['items'],
): TurnPage => {
  const held = pages.at(-1)

  if (held === undefined) {
    return {
      turn: 0,
      items: [
        ...compactionMarks(items).map((mark) => compactionOf(mark, 0)),
        ...interactions.map((interaction) => interactionOf(interaction, 0, 0)),
      ],
    }
  }
  if (interactions.length === 0) {
    return held
  }
  return {
    ...held,
    items: [...held.items, ...interactions.map((interaction) => interactionOf(interaction, held.turn, 0))],
  }
}

/*
 * agent 自己报的，落在标记上，判据是 marker 名（`compaction`）。读不出的格子如实缺席 —— 编一个数更坏。
 */
function compactionMarks(items: AgentTranscriptSnapshot['items']): readonly TranscriptMarker[] {
  return items.filter((item): item is TranscriptMarker => item.kind === 'marker' && item.marker === 'compaction')
}

/*
 * 压缩那一行落在哪：条目序里它前面最近的那一轮（第一轮之前的归第一轮的开头）；页内按时刻插在
 * 它之后才开始的第一条之前 —— 一次 omp turn 里中途压缩，压缩之后的段在它下面，而不是全堆在它上面。
 * 从前一律挂在活动段尾部：完整经过里有好几次压缩时，它们会全挤在最后一轮的末尾（审查 R-21-1）。
 * 页按基础页身份记账：sealed 段的页引用必须稳定（presentation 的 PREFIX/SEGMENTS 缓存全靠它）。
 */
const COMPACTED_PAGES = new WeakMap<
  TurnPage,
  { readonly lead: readonly TranscriptMarker[]; readonly marks: readonly TranscriptMarker[]; page: TurnPage }
>()

const NO_MARKS: readonly TranscriptMarker[] = []

const sameMarks = (left: readonly TranscriptMarker[], right: readonly TranscriptMarker[]): boolean =>
  left.length === right.length && left.every((mark, at) => mark === right[at])

function placeCompactions(pages: readonly TurnPage[], items: AgentTranscriptSnapshot['items']): readonly TurnPage[] {
  if (pages.length === 0) {
    return pages
  }

  const lead: TranscriptMarker[] = []
  const held = new Map<number, TranscriptMarker[]>()
  let seen = -1

  for (const item of items) {
    if (item.kind === 'turn') {
      seen += 1
      continue
    }
    if (item.kind !== 'marker' || item.marker !== 'compaction') {
      continue
    }
    if (seen < 0) {
      lead.push(item)
      continue
    }
    const list = held.get(seen)
    if (list === undefined) {
      held.set(seen, [item])
    } else {
      list.push(item)
    }
  }

  if (lead.length === 0 && held.size === 0) {
    return pages
  }

  return pages.map((page, at) => {
    const marks = held.get(at) ?? NO_MARKS
    const first = at === 0 ? lead : NO_MARKS
    return marks.length === 0 && first.length === 0 ? page : compactedPage(page, first, marks)
  })
}

function compactedPage(
  page: TurnPage,
  lead: readonly TranscriptMarker[],
  marks: readonly TranscriptMarker[],
): TurnPage {
  const kept = COMPACTED_PAGES.get(page)

  if (kept !== undefined && sameMarks(kept.lead, lead) && sameMarks(kept.marks, marks)) {
    return kept.page
  }

  const items: TimelineItem[] = [...lead.map((mark) => compactionOf(mark, page.turn)), ...page.items]

  for (const mark of marks) {
    const row = compactionOf(mark, page.turn)
    /* 第 0 条是这一轮的开场（人话 / 续跑）：压缩不会插到开场前面 */
    const after = items.findIndex((item, index) => index > lead.length && item.at > row.at)
    if (after < 0) {
      items.push(row)
    } else {
      items.splice(after, 0, row)
    }
  }

  const fresh = { ...page, items }
  COMPACTED_PAGES.set(page, { lead, marks, page: fresh })

  return fresh
}

function compactionOf(mark: TranscriptMarker, turn: number): CompactionTimelineItem {
  const payload =
    typeof mark.payload === 'object' && mark.payload !== null ? (mark.payload as Record<string, unknown>) : {}

  const state = compactionStateOf(payload.state)
  const trigger = payload.trigger
  const instruction = payload.instruction
  const tokensBefore = countOf(payload.tokensBefore)
  const tokensAfter = countOf(payload.tokensAfter)
  /* 展开那一面给人读：有 PR 式短摘要就用它，没有才用整份摘要 */
  const summary = textOf(payload.shortSummary) ?? textOf(payload.summary)
  const error = textOf(payload.error)
  const warning = textOf(payload.warning)

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
    ...(summary === undefined ? {} : { summary }),
    ...(error === undefined ? {} : { error }),
    ...(warning === undefined ? {} : { warning }),
    ...(payload.superseded === true ? { superseded: true as const } : {}),
  }
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 认不出的状态按「正在跑」处理：报完成会把一次没成的压缩说成成了。 */
function compactionStateOf(value: unknown): CompactionState {
  return value === 'blocked' || value === 'cancelled' || value === 'completed' || value === 'failed' ? value : 'running'
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

/*
 * 上游 reducer 只把真改动的那一个 step 换成新对象，其余复用。ordinal 与兜底时间戳必须在判据里：turn 对象每帧都换。
 */
interface StepFrames {
  readonly ordinal: number
  readonly fallback: number
  readonly items: readonly TimelineItem[]
  /** 这一段里人话帧引用的附件号（多数段为空），与投影那一刻解析到的条目逐一对应 —— 条目换了就不能复用。 */
  readonly refIds: readonly string[]
  readonly sources: readonly (TranscriptAttachment | undefined)[]
}

const STEP_FRAMES = new WeakMap<TranscriptTurn['steps'][number], StepFrames>()

const resolveIds = (
  ids: readonly string[],
  index: ReadonlyMap<string, TranscriptAttachment>,
): readonly (TranscriptAttachment | undefined)[] => (ids.length === 0 ? [] : ids.map((id) => index.get(id)))

/* 缓存命中的判据：没引用附件的段（绝大多数）一次比较都不做。 */
const sameRefs = (
  held: { readonly refIds: readonly string[]; readonly sources: readonly (TranscriptAttachment | undefined)[] },
  index: ReadonlyMap<string, TranscriptAttachment>,
): boolean => held.refIds.length === 0 || sameSources(held.sources, resolveIds(held.refIds, index))

function frameRefIdsOf(step: TranscriptTurn['steps'][number]): readonly string[] {
  let ids: string[] | null = null
  for (const frame of step.frames) {
    if (frame.kind === 'text' && frame.role === 'user' && (frame.attachmentIds?.length ?? 0) > 0) {
      ids ??= []
      ids.push(...(frame.attachmentIds ?? []))
    }
  }
  return ids ?? NO_IDS
}

function projectStep(
  step: TranscriptTurn['steps'][number],
  ordinal: number,
  fallback: number,
  index: ReadonlyMap<string, TranscriptAttachment>,
): StepFrames {
  const held = STEP_FRAMES.get(step)
  if (held !== undefined && held.ordinal === ordinal && held.fallback === fallback && sameRefs(held, index)) {
    return held
  }
  const items: TimelineItem[] = []
  for (const frame of step.frames) {
    const projected = frameOf(frame, ordinal, at(step.startedAt) || fallback, index)
    if (projected !== null) {
      items.push(projected)
    }
  }
  const refIds = frameRefIdsOf(step)
  const fresh: StepFrames = { ordinal, fallback, items, refIds, sources: resolveIds(refIds, index) }
  STEP_FRAMES.set(step, fresh)
  return fresh
}

function framesOf(
  turn: TranscriptTurn,
  stamp: number,
  index: ReadonlyMap<string, TranscriptAttachment>,
): {
  items: readonly TimelineItem[]
  refIds: readonly string[]
} {
  const items: TimelineItem[] = []
  let refIds: readonly string[] = NO_IDS
  for (const step of turn.steps) {
    const projected = projectStep(step, turn.ordinal, stamp, index)
    items.push(...projected.items)
    if (projected.refIds.length > 0) refIds = [...refIds, ...projected.refIds]
  }
  return { items, refIds }
}

// 按 turn 对象身份记账：上游 reducer 结构共享，没变的 turn 复用上次投影。
const TURN_PROJECTIONS = new WeakMap<
  TranscriptTurn,
  {
    /** 轮头与本轮各插话帧引用的全部附件号：turn 对象没换时号也不会换，只需再比一次解析到的条目。 */
    readonly refIds: readonly string[]
    readonly sources: readonly (TranscriptAttachment | undefined)[]
    page: TurnPage
    span: TurnSpan
  }
>()

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
  span: TurnSpan
} {
  const cached = TURN_PROJECTIONS.get(turn)
  if (cached !== undefined && sameRefs(cached, index)) {
    return cached
  }

  const stamp = at(turn.startedAt)
  const source = sourceOfTurn(turn)
  const hasInput = turn.prompt !== undefined || (turn.attachmentIds?.length ?? 0) > 0
  const attached = hasInput ? attachmentsOf(turn.attachmentIds, index) : NO_TURN_ATTACHMENTS
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
  const frames = framesOf(turn, stamp, index)
  const items = [...(opened === null ? [] : [opened]), ...frames.items]
  errorItemOf(turn, items, stamp)
  const outcome = outcomeOf(turn.state)
  const refIds = [...(turn.attachmentIds ?? NO_IDS), ...frames.refIds]
  const projected = {
    refIds,
    sources: resolveIds(refIds, index),
    page: {
      turn: turn.ordinal,
      ...(outcome === undefined ? {} : { outcome }),
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      items,
    },
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
    wrapped.run.keepTurns === run.keepTurns &&
    wrapped.run.forkUnavailableReason === run.forkUnavailableReason
  ) {
    return wrapped
  }
  const fresh = { ...page, run }
  WRAPPED_PAGES.set(page, fresh)
  return fresh
}

/**
 * 每一轮的分叉事实。分叉按**轮号**截（`threads.fork` 的 `keepTurns` = 这一轮的 `turn.ordinal`）：
 * 轮号是引擎签发的，引擎按同一套分轮规则认回，界面不必再替它数「后面还有几个用户锚点」——
 * 也就不再有「压缩之后 / 用过技能 / 目标续跑 / 合并提示」这些数不清就只好禁用的情形。
 * 只剩一个限制：会话还在跑（或这一轮还没收口）时不分叉，磁盘上的会话文件还没写完。
 */
function runBoundariesOf(pages: readonly TurnPage[], turns: readonly TranscriptTurn[], busy: boolean): TurnPage[] {
  return pages.map((page, at) => {
    const turn = turns[at]
    if (turn === undefined) {
      invariant(false, 'Transcript run projection is incomplete.')
    }
    const settled = isSettled(turn.state)
    const reason = busy || !settled ? '会话仍在运行或等待输入，暂不可分叉。' : null
    return wrappedPage(page, {
      settled,
      keepTurns: reason === null ? turn.ordinal : null,
      forkUnavailableReason: reason,
    })
  })
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
    /* 不再只看轮头：插话帧也带附件（R-19-1），只看轮头会让插话那一句的图永远解析不到。 */
    snapshot.attachments.length > 0
      ? new Map(snapshot.attachments.map((attachment) => [attachment.attachmentId, attachment]))
      : EMPTY_INDEX
  const pages: TurnPage[] = []
  const spans: TurnSpan[] = []
  for (const turn of turns) {
    const projected = projectTurn(turn, attachmentIndex)
    pages.push(projected.page)
    spans.push(projected.span)
  }
  const marked = runBoundariesOf(pages, turns, busy)
  const anchored = anchorQuestions(marked, snapshot.interactions)
  const placed = { pages: placeCompactions(anchored.pages, snapshot.items), tail: anchored.tail }
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
