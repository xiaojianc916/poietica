import type {
  AgentTranscriptSnapshot,
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptTask,
  TranscriptTurn,
} from '@poietica/transcript'
import type { QuestionItem } from '../agent/question'
import type { TurnMark } from '../agent/thread'
import type { ToolCallContent } from '../agent/tool-call'
import type {
  BackgroundTaskItem,
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

interface InputSource {
  readonly isUser: boolean
  readonly anchors: number | null
}

const USER_INPUT: InputSource = { isUser: true, anchors: 1 }

const originField = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

/** 技能激活由用户来源描述符携带（TranscriptUserOrigin.skillActivations）。 */
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

/** 一条 turn 的附件投成什么：图片（可能还在代取字节）与通用文件卡片。 */
interface TurnAttachments {
  readonly images: MessageImage[]
  readonly files: MessageFile[]
}

const NO_TURN_ATTACHMENTS: TurnAttachments = { images: [], files: [] }

/**
 * 媒体字节的解析结果：fileId -> data/asset URL。
 *
 * 历史图片在 agent 的 media 端点后（要 Bearer），webview 直连不了，由 store 经
 * 原生侧代取后填进这张表；投影器只读表、不发请求。空表是一个稳定的共享常量。
 */
const EMPTY_MEDIA: ReadonlyMap<string, string> = new Map()

/** 没有附件可查时的稳定空表：与 EMPTY_MEDIA 同理，免得白建一张 Map。 */
const EMPTY_INDEX: ReadonlyMap<string, TranscriptAttachment> = new Map()

/**
 * 附件画成图还是卡片。
 *
 * 判据是「有没有能取回像素的 source」，不是 media_type：agent 只给可显示的图片
 * 记 source，给不了的那种（模型不收的格式、被降级成文件的图）本来就只能是卡片。
 * 只看 media_type 会把这类附件画成永远转圈的占位。
 */
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

/** 这句附件是一张要画的图吗：图片类型，而且 agent 给了能取回字节的 source。 */
const isDrawableImage = (attachment: TranscriptAttachment): boolean =>
  attachment.mediaType.startsWith('image/') && attachment.source !== undefined

/**
 * 这张图的字节要在原生侧代取吗：是图，而且 source 不是现成的 URL。
 *
 * 投影器不在这里发请求，store 代取；两处问的是同一个问题，所以只有这一个判据。
 */
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
      // 字节还没代取回来：先占位，store 解析完换图；取失败也停在占位，不挡对话。
      images.push(url === undefined ? { pending: true } : { url })
    } else {
      const name = attachment.name ?? '附件'
      files.push({ name, meta: fileMetaLabel(name, attachment.size) })
    }
  }
  return { images, files }
}

/**
 * 只有真的用户输入才成行；其它来源的运行不伪造消息气泡。
 *
 * 正文里混着给模型看的附件句子，气泡只画人说的话：附件由卡片画，句子在这里
 * 摘掉（见 kimi-attachment.ts）。开场与中途插话走的是同一个判据。
 */
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
  const tool = describeTool(frame)
  return {
    type: 'tool_call',
    id: frame.frameId,
    turn,
    at: stamp,
    toolCallId: frame.toolCallId,
    title: frame.name,
    ...tool,
    status:
      frame.state === 'running' ? 'in_progress' : frame.state === 'error' ? 'failed' : 'completed',
    requestContent: textContent(frame.inputText || JSON.stringify(frame.input, null, 2)),
    content: textContent(frame.error ?? frame.output),
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

function interactionOf(
  interaction: TranscriptInteraction,
  turn: number,
  stamp: number,
): PermissionItem | QuestionTimelineItem {
  const resolved = interaction.state !== 'pending'
  if (interaction.interactionKind === 'approval') {
    return {
      type: 'permission',
      id: interaction.interactionId,
      turn,
      at: stamp,
      requestId: interaction.interactionId,
      title: interaction.toolCallId ?? 'Approval',
      kind: 'other',
      subject: '',
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

/* 待答的审批与提问挂在活动段：interactions 全局于轮次，而屏幕上它们
出现在这条对话当前的尾部。 */
const tailOf = (
  pages: readonly TurnPage[],
  interactions: AgentTranscriptSnapshot['interactions'],
): TurnPage => {
  const held = pages.at(-1)
  if (held === undefined) {
    return {
      turn: 0,
      items: interactions.map((interaction) => interactionOf(interaction, 0, 0)),
    }
  }
  return {
    ...held,
    items: [
      ...held.items,
      ...interactions.map((interaction) => interactionOf(interaction, held.turn, 0)),
    ],
  }
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

/*
 * Turn 的投影按对象身份记账。上游 reducer 是结构共享的：一条 op 只换它碰到的
 * 那一个 turn（`{ ...turn, steps }`），其余 turn 原样保留 —— 所以没变的 turn
 * 直接复用上一次的投影，流式期间每条 delta 只重算正在变的那一个，而不是整本
 * 对话。presentation 层的行身份（WeakMap<TimelineItem>）也依赖这份身份成立：
 * 投影每次新建的话，全部行位的 memo 都会被击穿。
 *
 * 带附件的 turn 还依赖两本外部集合：attachment.upsert 换 attachments、媒体字节
 * 取回来换 media 表，而 turn 自身一动不动。判据得跟着这两本走，否则图片永远停在
 * 占位。它们按**引用**比：attachments 是每次 snapshot 重建的数组，所以只比对这条
 * turn 真正用到的那几个附件对象；media 表只在解析成功后换新，可以直接比身份。
 */
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

/** 这条 turn 用到的附件对象，按 attachmentIds 的顺序；缺席的是找不到的 id。 */
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
  /* 正文里混着给模型看的附件句子，inputItem 会把它们摘掉。 */
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

// :undo removes a suffix ending at a user anchor, not at an arbitrary run.

/*
 * 包裹页按基础页的身份记账。run 的三个字段由后缀推出：busy、锚点与后缀形状不变
 * 时，历史段的 run 逐字段相同 —— 原样复用上一次的包裹页。TurnPage 的契约是
 * 「封口之后不再改写，跨帧按引用共享」，presentation 层按页身份的段缓存
 * （WeakMap<TurnPage>）依赖它成立；这里每次新建一个壳，那条缓存就永远不命中。
 */
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
    active: tailOf(marked, snapshot.interactions),
    lastSeq: 0,
    spans,
  }
}

/* 目录标记同样按 turn 身份记账：reply 那一格要 join 整轮的助手文本，长对话里
   每条 delta 都重算一遍就是纯粹的分配 churn。turn 未变时标记原样复用。 */
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
        /* 侧栏的小地图也画人说的话：与气泡同一条摘除规矩。 */
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
