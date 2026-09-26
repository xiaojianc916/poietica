import type {
  AgentTranscriptSnapshot,
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptMarker,
  TranscriptTask,
  TranscriptTurn,
} from '@poietica/transcript'
import type { QuestionItem } from '../agent/question'
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

function frameOf(frame: TranscriptFrame, turn: number, stamp: number): TimelineItem | null {
  if (frame.kind === 'text') {
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
  if (frame.kind === 'thinking') {
    return {
      type: 'agent_thought',
      id: frame.frameId,
      turn,
      at: stamp,
      text: frame.text,
      sealed: true,
    }
  }
  if (frame.kind === 'notice') {
    return { type: 'error', id: frame.frameId, turn, at: stamp, message: frame.message }
  }
  const tool = describeTool(frame.input)
  const view = ompToolView(frame.name, frame.input, frame.output, frame.error, frame.intent)
  return {
    type: 'tool_call',
    id: frame.frameId,
    turn,
    at: stamp,
    toolCallId: frame.toolCallId,
    title: frame.name,
    kind: view.known ? view.kind : tool.kind,
    headline: view.headline,
    subject: view.subject || tool.subject,
    shape: view.shape,
    ...(view.background ? { isBackground: true as const } : {}),
    status:
      frame.state === 'running' ? 'in_progress' : frame.state === 'error' ? 'failed' : 'completed',
    requestContent: view.request.length > 0 ? view.request : textContent(jsonOf(frame.input)),
    content: view.response.length > 0 ? view.response : textContent(frame.error ?? frame.output),
    locations: [],
    channels: (frame.agentRefs ?? []).map((agent) => ({
      agentId: agent.agentId,
      name: agent.agentId,
    })),
    rawInput: frame.input,
    rawOutput: frame.output,
    startedAt: stamp,
    ...(frame.state === 'running' ? {} : { endedAt: stamp }),
  } satisfies ToolCallTimelineItem
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
          resolution: { outcome: questionOutcome(interaction.state), answers: {}, note: '' },
        }
      : {}),
  }
}
const backgroundOf = (task: TranscriptTask): BackgroundTaskItem | null =>
  task.detached
    ? { taskId: task.taskId, description: task.description ?? task.taskId, status: task.state }
    : null

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
 * 待答的审批与提问挂在活动段尾部；压缩那一条也在这里 —— 它不绑 turn
 * （agent 压缩的是上下文，不是某一轮），所以没有自己的页可挂。
 */
const tailOf = (
  pages: readonly TurnPage[],
  interactions: AgentTranscriptSnapshot['interactions'],
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

function framesOf(
  turn: TranscriptTurn,
  stamp: number,
): {
  items: TimelineItem[]
  userAnchors: number | null
} {
  const items: TimelineItem[] = []
  let userAnchors: number | null = 0
  for (const step of turn.steps) {
    for (const frame of step.frames) {
      const projected = frameOf(frame, turn.ordinal, at(step.startedAt) || stamp)
      if (projected !== null) {
        items.push(projected)
      }
      if (frame.kind === 'text' && frame.role === 'user') {
        const count = sourceOfFrame(frame).anchors
        userAnchors = userAnchors === null || count === null ? null : userAnchors + count
      }
    }
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
  if (
    turn.error !== undefined &&
    turn.error.length > 0 &&
    !items.some((item) => item.type === 'error' && item.message === turn.error)
  ) {
    items.push({
      type: 'error',
      id: `turn-error:${turn.turnId}`,
      turn: turn.ordinal,
      at: timeOf(turn.endedAt) ?? stamp,
      message: turn.error,
    })
  }
  const projected = {
    sources: sourcesOf(turn, index),
    media,
    page: { turn: turn.ordinal, items },
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
  return {
    status,
    backgroundTasks: snapshot.tasks
      .map(backgroundOf)
      .filter((item): item is BackgroundTaskItem => item !== null),
    sealed: marked.length === 0 ? [] : marked.slice(0, -1),
    active: tailOf(marked, snapshot.interactions, snapshot.items),
    lastSeq: 0,
    spans,
  }
}

// 目录标记按 turn 身份记账：reply 要 join 整轮助手文本，turn 未变时复用。
const TURN_MARKS = new WeakMap<TranscriptTurn, TurnMark>()

export const outlineOf = (snapshot: AgentTranscriptSnapshot): readonly TurnMark[] =>
  snapshot.items.flatMap((item) => {
    if (item.kind !== 'turn' || !sourceOfTurn(item).isUser) {
      return []
    }

    let mark = TURN_MARKS.get(item)

    if (mark === undefined) {
      mark = {
        turnId: item.turnId,
        admissionId: item.triggerPromptId ?? item.turnId,
        prompt: withoutKimiAttachmentNotices(item.prompt ?? ''),
        reply:
          item.steps
            .flatMap((step) => step.frames)
            .filter((frame) => frame.kind === 'text' && frame.role === 'assistant')
            .map((frame) => frame.text)
            .join('\n\n') || null,
      }
      TURN_MARKS.set(item, mark)
    }

    return [mark]
  })

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
