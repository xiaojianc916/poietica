import type {
  AgentTranscriptSnapshot,
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
  PermissionItem,
  QuestionTimelineItem,
  TimelineItem,
  TimelineState,
  ToolCallTimelineItem,
  TurnPage,
  TurnSpan,
  UserMessageItem,
} from '../timeline/timeline-contract'

import { isInFlight } from '../timeline/timeline-contract'
import { describeKimiTool } from './kimi-tool'

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

/** 只有真的用户输入才成行；其它来源的运行不伪造消息气泡。 */
function inputItem(
  source: InputSource,
  id: string,
  turn: number,
  stamp: number,
  text: string,
  skills: readonly string[],
): UserMessageItem | null {
  return source.isUser
    ? {
        type: 'user_message',
        id,
        turn,
        at: stamp,
        text,
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
  const tool = describeKimiTool(frame)
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

function projectTurn(turn: TranscriptTurn): {
  page: TurnPage
  fact: TurnFact
  span: TurnSpan
} {
  const stamp = at(turn.startedAt)
  const source = sourceOfTurn(turn)
  const hasInput = turn.prompt !== undefined || (turn.attachmentIds?.length ?? 0) > 0
  const opening = hasInput ? source.anchors : source.isUser ? null : 0
  const opened =
    turn.prompt === undefined
      ? null
      : inputItem(
          source,
          turn.triggerPromptId ?? turn.turnId,
          turn.ordinal,
          stamp,
          turn.prompt,
          skillNamesOf(turn.origin.payload),
        )
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
  return {
    page: { turn: turn.ordinal, items },
    fact: { opensWithAnchor: opening === 1, anchors },
    span: spanOf(turn, turn.ordinal),
  }
}

// :undo removes a suffix ending at a user anchor, not at an arbitrary run.
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
    result[runIndex] = {
      ...page,
      run: {
        settled,
        undoCount: reason === null ? suffixAnchors : null,
        forkUnavailableReason: reason,
      },
    }
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

export function projectTranscript(snapshot: AgentTranscriptSnapshot): TimelineState {
  const turns = snapshot.items.filter((item): item is TranscriptTurn => item.kind === 'turn')
  const status = phaseOf(snapshot, turns.at(-1))
  const busy =
    isInFlight(status) ||
    turns.some((turn) => !isSettled(turn.state)) ||
    (snapshot.meta.activity !== undefined && snapshot.meta.activity !== 'idle')
  const pages: TurnPage[] = []
  const spans: TurnSpan[] = []
  const facts: TurnFact[] = []
  for (const turn of turns) {
    const projected = projectTurn(turn)
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

export const outlineOf = (snapshot: AgentTranscriptSnapshot): readonly TurnMark[] =>
  snapshot.items.flatMap((item) =>
    item.kind === 'turn' && sourceOfTurn(item).isUser
      ? [
          {
            turnId: item.turnId,
            admissionId: item.triggerPromptId ?? item.turnId,
            prompt: item.prompt ?? '',
            reply:
              item.steps
                .flatMap((step) => step.frames)
                .filter((frame) => frame.kind === 'text' && frame.role === 'assistant')
                .map((frame) => frame.text)
                .join('\n\n') || null,
          },
        ]
      : [],
  )

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
