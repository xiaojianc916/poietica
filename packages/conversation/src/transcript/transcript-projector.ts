import type {
  AgentTranscriptSnapshot,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptTask,
  TranscriptTurn,
} from '@poietica/transcript'
import type { QuestionItem } from '../agent/question'
import type { TurnMark } from '../agent/thread'
import type { ToolCallContent, ToolKind } from '../agent/tool-call'
import type {
  BackgroundTaskItem,
  PermissionItem,
  QuestionTimelineItem,
  TimelineItem,
  TimelineState,
  ToolCallTimelineItem,
  TurnPage,
  TurnSpan,
} from '../timeline/timeline-contract'

import { isInFlight } from '../timeline/timeline-contract'

const at = (value?: string): number => (value === undefined ? 0 : Date.parse(value))
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
const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  command: 'execute',
  diff: 'edit',
  search: 'search',
  url_fetch: 'fetch',
  agent_call: 'delegate',
  skill_call: 'skill',
  todo_list: 'todo',
  task: 'task',
  task_stop: 'task',
  plan_review: 'plan',
  goal_start: 'goal',
}
const FILE_IO_KINDS: Readonly<Record<string, ToolKind>> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
}
const kindOf = (display: unknown): ToolKind => {
  const kind =
    typeof display === 'object' && display !== null ? Reflect.get(display, 'kind') : undefined
  if (kind === 'file_io') {
    const operation =
      typeof display === 'object' && display !== null
        ? Reflect.get(display, 'operation')
        : undefined
    return FILE_IO_KINDS[typeof operation === 'string' ? operation : ''] ?? 'search'
  }
  return TOOL_KINDS[typeof kind === 'string' ? kind : ''] ?? 'other'
}
const textContent = (value: unknown): readonly ToolCallContent[] =>
  typeof value === 'string' && value.length > 0
    ? [{ type: 'content', content: { type: 'text', text: value } }]
    : []
const subjectOf = (display: unknown): string => {
  if (typeof display !== 'object' || display === null) {
    return ''
  }
  for (const key of [
    'command',
    'path',
    'query',
    'url',
    'prompt',
    'description',
    'plan',
    'objective',
    'summary',
  ]) {
    const value = Reflect.get(display, key)
    if (typeof value === 'string') {
      return value
    }
  }
  return ''
}
interface InputSource {
  readonly isUser: boolean
  readonly label: string
  readonly anchors: number | null
}

const USER_INPUT: InputSource = { isUser: true, label: '用户', anchors: 1 }
const SOURCE_LABELS: Readonly<Record<TranscriptTurn['origin']['kind'], string>> = {
  user: '用户来源',
  cron: '定时任务',
  task: '后台任务',
  hook: '钩子触发',
  compaction: '上下文压缩',
  side: '旁路运行',
  other: '其他来源',
}

const originField = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

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
      return {
        isUser: originField(origin.payload, 'phase') === 'input',
        label: '终端命令',
        anchors: 0,
      }
    }
    return { ...USER_INPUT, anchors: null }
  }
  return {
    isUser: false,
    label: SOURCE_LABELS[origin.kind],
    anchors: origin.kind === 'other' ? null : 0,
  }
}

function sourceOfFrame(frame: Extract<TranscriptFrame, { role: 'user' }>): InputSource {
  if (frame.origin?.kind === 'user') {
    return { ...USER_INPUT, anchors: (frame.promptIds?.length ?? 0) > 1 ? null : 1 }
  }
  return {
    isUser: false,
    label: frame.taskId === undefined ? '其他来源' : '后台任务',
    anchors: frame.taskId === undefined ? null : 0,
  }
}

function inputItem(
  source: InputSource,
  id: string,
  turn: number,
  stamp: number,
  text: string,
): TimelineItem {
  const entry = { id, turn, at: stamp, text }
  return source.isUser
    ? { ...entry, type: 'user_message' }
    : { ...entry, type: 'run_trigger', label: source.label }
}

const isSettled = (state: TranscriptTurn['state']): boolean =>
  state === 'completed' || state === 'cancelled' || state === 'failed'

function frameOf(frame: TranscriptFrame, turn: number, stamp: number): TimelineItem {
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
    return inputItem(sourceOfFrame(frame), frame.frameId, turn, stamp, frame.text)
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
  const display = frame.display
  return {
    type: 'tool_call',
    id: frame.frameId,
    turn,
    at: stamp,
    toolCallId: frame.toolCallId,
    title: frame.name,
    kind: kindOf(display),
    subject: subjectOf(display),
    status:
      frame.state === 'running' ? 'in_progress' : frame.state === 'error' ? 'failed' : 'completed',
    requestContent: textContent(frame.inputText),
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

const spanOf = (turn: TranscriptTurn, index: number): TurnSpan => ({
  turn: index,
  ...(turn.durationMs === undefined ? {} : { durationMs: Math.max(0, turn.durationMs) }),
  ...(turn.startedAt === undefined ? {} : { startedAt: at(turn.startedAt) }),
  ...(turn.endedAt === undefined ? {} : { endedAt: at(turn.endedAt) }),
  lastFrameAt: at(turn.endedAt ?? turn.startedAt),
})

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

export function projectTranscript(snapshot: AgentTranscriptSnapshot): TimelineState {
  const turns = snapshot.items.filter((item): item is TranscriptTurn => item.kind === 'turn')
  const status = phaseOf(snapshot, turns.at(-1))
  const busy =
    isInFlight(status) ||
    turns.some((turn) => !isSettled(turn.state)) ||
    (snapshot.meta.activity !== undefined && snapshot.meta.activity !== 'idle')
  const pages: TurnPage[] = []
  const spans: TurnSpan[] = []
  const facts: { opensWithAnchor: boolean; anchors: number | null }[] = []
  for (const turn of turns) {
    const stamp = at(turn.startedAt)
    const source = sourceOfTurn(turn)
    const hasInput = turn.prompt !== undefined || (turn.attachmentIds?.length ?? 0) > 0
    const opening = hasInput ? source.anchors : source.isUser ? null : 0
    let anchors = opening
    const items: TimelineItem[] =
      turn.prompt === undefined && source.isUser
        ? []
        : [
            inputItem(
              source,
              turn.triggerPromptId ?? turn.turnId,
              turn.ordinal,
              stamp,
              turn.prompt ?? '',
            ),
          ]
    for (const step of turn.steps) {
      for (const frame of step.frames) {
        items.push(frameOf(frame, turn.ordinal, at(step.startedAt) || stamp))
        if (frame.kind === 'text' && frame.role === 'user') {
          const count = sourceOfFrame(frame).anchors
          anchors = anchors === null || count === null ? null : anchors + count
        }
      }
    }
    pages.push({ turn: turn.ordinal, items })
    facts.push({ opensWithAnchor: opening === 1, anchors })
    spans.push(spanOf(turn, turn.ordinal))
  }

  // :undo removes a suffix ending at a user anchor, not at an arbitrary run.
  let suffixAnchors = 0
  let nextOpensWithAnchor = true
  let uncertainty: string | null = null
  let runIndex = pages.length - 1
  for (const item of snapshot.items.toReversed()) {
    if (item.kind !== 'turn') {
      uncertainty = '包含压缩或其他边界标记，无法证明精确截断。'
      continue
    }
    const page = pages[runIndex]
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
    pages[runIndex] = {
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
  return {
    status,
    backgroundTasks: snapshot.tasks
      .map(backgroundOf)
      .filter((item): item is BackgroundTaskItem => item !== null),
    sealed: pages.length === 0 ? [] : pages.slice(0, -1),
    active: tailOf(pages, snapshot.interactions),
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
