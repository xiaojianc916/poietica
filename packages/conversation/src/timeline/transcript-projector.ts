import type {
  AgentTranscriptSnapshot,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptTask,
  TranscriptTurn,
} from '@poietica/transcript'
import type { QuestionItem, ToolCallContent, ToolKind, TurnMark } from '../agent'
import type {
  BackgroundTaskItem,
  PermissionItem,
  QuestionTimelineItem,
  TimelineItem,
  TimelineState,
  ToolCallTimelineItem,
  TurnPage,
  TurnSpan,
} from './timeline-contract'

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
function frameOf(frame: TranscriptFrame, turn: number, stamp: number): TimelineItem {
  if (frame.kind === 'text') {
    return {
      type: frame.role === 'user' ? 'user_message' : 'agent_text',
      id: frame.frameId,
      turn,
      at: stamp,
      text: frame.text,
      ...(frame.role === 'assistant' ? { sealed: true } : {}),
    } as TimelineItem
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
  const pages: TurnPage[] = []
  const spans: TurnSpan[] = []
  for (const turn of turns) {
    const stamp = at(turn.startedAt)
    const items: TimelineItem[] =
      turn.prompt === undefined
        ? []
        : [
            {
              type: 'user_message',
              id: turn.triggerPromptId ?? turn.turnId,
              turn: turn.ordinal,
              at: stamp,
              text: turn.prompt,
            },
          ]
    for (const step of turn.steps) {
      for (const frame of step.frames) {
        items.push(frameOf(frame, turn.ordinal, at(step.startedAt) || stamp))
      }
    }
    pages.push({ turn: turn.ordinal, items })
    spans.push(spanOf(turn, turn.ordinal))
  }
  return {
    status: phaseOf(snapshot, turns.at(-1)),
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
    item.kind === 'turn'
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
