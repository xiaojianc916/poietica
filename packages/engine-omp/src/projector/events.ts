import type {
  AgentEvent,
  StepHeader,
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptMarker,
  TranscriptMetaMerge,
  TranscriptTask,
  TranscriptTodo,
  TurnHeader,
} from '@poietica/agent-model'

/*
 * 投影层的唯一事件构造口：实时与历史两条路都从这里出 AgentEvent。
 * 信封里的 threadId / agentId / seq 由 Core 在写入与广播时补，投影层只管“发生了什么”。
 */

const SCHEMA = 1

export function runStarted(run: TurnHeader, at: string): AgentEvent {
  return { type: 'run.started', durability: 'committed', schema: SCHEMA, at, runId: run.turnId, run }
}

export function runCompleted(
  run: TurnHeader,
  outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted',
  at: string,
): AgentEvent {
  return {
    type: 'run.completed',
    durability: 'committed',
    schema: SCHEMA,
    at,
    runId: run.turnId,
    outcome,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(run.usage === undefined ? {} : { usage: run.usage }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(run.error === undefined ? {} : { error: run.error }),
  }
}

export function stepStarted(turn: string, step: StepHeader, at: string): AgentEvent {
  return { type: 'step.started', durability: 'committed', schema: SCHEMA, at, runId: turn, turnId: turn, step }
}

export function stepRetrying(turn: string, step: StepHeader, at: string): AgentEvent {
  return { type: 'step.retrying', durability: 'committed', schema: SCHEMA, at, runId: turn, turnId: turn, step }
}

export function stepCompleted(turn: string, step: StepHeader, at: string): AgentEvent {
  return { type: 'step.completed', durability: 'committed', schema: SCHEMA, at, runId: turn, turnId: turn, step }
}

export function itemStarted(turn: string, step: string, frame: TranscriptFrame, at: string): AgentEvent {
  return {
    type: 'item.started',
    durability: 'committed',
    schema: SCHEMA,
    at,
    runId: turn,
    turnId: turn,
    stepId: step,
    itemId: frame.frameId,
    frame,
  }
}

export function itemCompleted(turn: string, step: string, frame: TranscriptFrame, at: string): AgentEvent {
  return {
    type: 'item.completed',
    durability: 'committed',
    schema: SCHEMA,
    at,
    runId: turn,
    turnId: turn,
    stepId: step,
    itemId: frame.frameId,
    frame,
  }
}

export function itemDelta(
  turn: string,
  step: string,
  frameId: string,
  channel: 'text' | 'thinking' | 'tool_input' | 'tool_output' | 'progress',
  at: string,
  text?: string,
  offset?: number,
  data?: unknown,
): AgentEvent {
  return {
    type: 'item.delta',
    durability: 'ephemeral',
    schema: SCHEMA,
    at,
    runId: turn,
    turnId: turn,
    stepId: step,
    itemId: frameId,
    frameId,
    channel,
    ...(text === undefined ? {} : { text }),
    ...(offset === undefined ? {} : { offset }),
    ...(data === undefined ? {} : { data }),
  }
}

export function itemsRemoved(ids: readonly string[], at: string): AgentEvent {
  return { type: 'item.removed', durability: 'committed', schema: SCHEMA, at, ids: [...ids] }
}

export function attachmentAdded(
  attachment: TranscriptAttachment,
  at: string,
): Extract<AgentEvent, { type: 'attachment.added' }> {
  return { type: 'attachment.added', durability: 'committed', schema: SCHEMA, at, attachment }
}

export function interactionRequested(interaction: TranscriptInteraction, at: string): AgentEvent {
  return {
    type: 'interaction.requested',
    durability: 'committed',
    schema: SCHEMA,
    at,
    itemId: interaction.interactionId,
    interaction,
  }
}

export function interactionResolved(interaction: TranscriptInteraction, at: string): AgentEvent {
  return {
    type: 'interaction.resolved',
    durability: 'committed',
    schema: SCHEMA,
    at,
    itemId: interaction.interactionId,
    interaction,
  }
}

export function compacted(item: TranscriptMarker, at: string, beforeTurn?: number): AgentEvent {
  return {
    type: 'context.compacted',
    durability: 'committed',
    schema: SCHEMA,
    at,
    itemId: item.markerId,
    item,
    ...(beforeTurn === undefined ? {} : { beforeTurn }),
  }
}

export function markerRaised(item: TranscriptMarker, at: string, beforeTurn?: number): AgentEvent {
  return {
    type: 'marker.raised',
    durability: 'committed',
    schema: SCHEMA,
    at,
    itemId: item.markerId,
    item,
    ...(beforeTurn === undefined ? {} : { beforeTurn }),
  }
}

export function taskEvent(task: TranscriptTask, at: string): AgentEvent {
  return {
    type: task.state === 'running' ? 'task.started' : 'task.finished',
    durability: 'committed',
    schema: SCHEMA,
    at,
    task,
  }
}

export function taskOutput(taskId: string, offset: number, text: string, at: string): AgentEvent {
  return {
    type: 'task.output',
    durability: 'ephemeral',
    schema: SCHEMA,
    at,
    taskId,
    offset,
    text,
  }
}

export function todoUpdated(todo: TranscriptTodo, at: string): AgentEvent {
  return { type: 'todo.updated', durability: 'committed', schema: SCHEMA, at, todo }
}

export function agentUpdated(meta: TranscriptMetaMerge, at: string): AgentEvent {
  return { type: 'agent.updated', durability: 'committed', schema: SCHEMA, at, meta }
}

export function noticeRaised(turn: string, step: string, frame: TranscriptFrame, at: string): AgentEvent {
  if (frame.kind !== 'notice') throw new Error('noticeRaised 只收 notice 帧')
  return {
    type: 'notice.raised',
    durability: 'committed',
    schema: SCHEMA,
    at,
    runId: turn,
    turnId: turn,
    stepId: step,
    itemId: frame.frameId,
    frame,
  }
}
