import type {
  AgentTranscriptSnapshot,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptTask,
  TranscriptTurn,
} from '@poietica/transcript'
import type { QuestionItem, ToolCallContent, ToolKind } from '../agent'
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
      ...(resolved
        ? {
            resolution: {
              decision:
                interaction.state === 'approved'
                  ? 'approved'
                  : interaction.state === 'rejected'
                    ? 'rejected'
                    : 'cancelled',
            },
          }
        : {}),
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
            outcome:
              interaction.state === 'answered'
                ? 'answered'
                : interaction.state === 'dismissed'
                  ? 'dismissed'
                  : 'cancelled',
            answers: {},
            note: '',
          },
        }
      : {}),
  }
}
const backgroundOf = (task: TranscriptTask): BackgroundTaskItem | null =>
  task.detached
    ? { taskId: task.taskId, description: task.description ?? task.taskId, status: task.state }
    : null

export function projectTranscript(snapshot: AgentTranscriptSnapshot): TimelineState {
  const turns = snapshot.items.filter((item): item is TranscriptTurn => item.kind === 'turn')
  const pages: TurnPage[] = []
  const spans: TurnSpan[] = []
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]
    if (turn === undefined) {
      continue
    }
    const stamp = at(turn.startedAt)
    const items: TimelineItem[] =
      turn.prompt === undefined
        ? []
        : [
            {
              type: 'user_message',
              id: turn.triggerPromptId ?? turn.turnId,
              turn: index,
              at: stamp,
              text: turn.prompt,
            },
          ]
    for (const step of turn.steps) {
      for (const frame of step.frames) {
        items.push(frameOf(frame, index, at(step.startedAt) || stamp))
      }
    }
    pages.push({ turn: index, items })
    spans.push({
      turn: index,
      ...(turn.startedAt === undefined ? {} : { startedAt: at(turn.startedAt) }),
      ...(turn.endedAt === undefined ? {} : { endedAt: at(turn.endedAt) }),
      lastFrameAt: at(turn.endedAt ?? turn.startedAt),
    })
  }
  const last = turns.at(-1)
  /* 待答的审批与提问挂在活动段：interactions 全局于轮次，而屏幕上它们
  出现在这条对话当前的尾部。 */
  const held = pages[pages.length - 1]
  const tail: TurnPage =
    held === undefined
      ? {
          turn: 0,
          items: snapshot.interactions.map((interaction) =>
            interactionOf(interaction, 0, Date.now()),
          ),
        }
      : {
          ...held,
          items: [
            ...held.items,
            ...snapshot.interactions.map((interaction) =>
              interactionOf(interaction, held.turn, Date.now()),
            ),
          ],
        }
  const sealed = held === undefined ? [] : pages.slice(0, -1)
  const pending = snapshot.interactions.some((item) => item.state === 'pending')
  const pendingApproval = snapshot.interactions.some(
    (item) => item.state === 'pending' && item.interactionKind === 'approval',
  )
  const status = pending
    ? pendingApproval
      ? 'awaiting_permission'
      : 'awaiting_question'
    : last === undefined
      ? 'idle'
      : statusOf(last.state)
  return {
    status,
    backgroundTasks: snapshot.tasks
      .map(backgroundOf)
      .filter((item): item is BackgroundTaskItem => item !== null),
    sealed,
    active: tail,
    lastSeq: 0,
    spans,
  }
}
