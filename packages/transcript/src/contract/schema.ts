import { z } from 'zod'

export const turnIdSchema = z.string().min(1)
export const stepIdSchema = z.string().min(1)
export const frameIdSchema = z.string().min(1)
export const taskIdSchema = z.string().min(1)
export const agentIdSchema = z.string().min(1)

export const transcriptSkillActivationSchema = z.object({
  skillName: z.string(),
  skillArgs: z.string().optional(),
})

export const transcriptUserOriginSchema = z.object({
  kind: z.literal('user'),
  skillActivations: z.array(transcriptSkillActivationSchema).optional(),
})

export const turnOriginSchema = z.discriminatedUnion('kind', [
  transcriptUserOriginSchema,
  z.object({ kind: z.literal('cron'), taskId: taskIdSchema.optional() }),
  z.object({ kind: z.literal('task'), taskId: taskIdSchema }),
  z.object({ kind: z.literal('hook') }),
  z.object({ kind: z.literal('compaction') }),
  z.object({ kind: z.literal('side') }),
  z.object({ kind: z.literal('other'), trigger: z.enum(['goal_continuation']).optional() }),
])

export const transcriptUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedTokens: z.number().optional(),
  cost: z.number().optional(),
})

export const stepUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
})

export const stepTimingSchema = z.object({
  llmFirstTokenLatencyMs: z.number().optional(),
  llmStreamDurationMs: z.number().optional(),
  llmRequestBuildMs: z.number().optional(),
  llmServerFirstTokenMs: z.number().optional(),
  llmServerDecodeMs: z.number().optional(),
  llmClientConsumeMs: z.number().optional(),
})

export const stepRetrySchema = z.object({
  failedAttempt: z.number(),
  nextAttempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number(),
  errorName: z.string(),
  errorMessage: z.string(),
  statusCode: z.number().optional(),
})

export const turnStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled'])
export const stepStateSchema = z.enum(['running', 'completed', 'interrupted', 'failed'])

const textFrameShape = {
  kind: z.literal('text'),
  frameId: frameIdSchema,
  text: z.string(),
  attachmentIds: z.array(z.string()).optional(),
  taskId: taskIdSchema.optional(),
  promptIds: z.array(z.string()).optional(),
}

export const textFrameSchema = z.discriminatedUnion('role', [
  z.object({ ...textFrameShape, role: z.literal('assistant'), origin: z.never().optional() }),
  z.object({
    ...textFrameShape,
    role: z.literal('user'),
    origin: transcriptUserOriginSchema.optional(),
  }),
])

export const thinkingFrameSchema = z.object({
  kind: z.literal('thinking'),
  frameId: frameIdSchema,
  text: z.string(),
})

export const agentRefSchema = z.object({
  agentId: agentIdSchema,
  role: z.enum(['child', 'member']).optional(),
})

export const toolFrameProgressSchema = z.object({
  kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
  text: z.string().optional(),
  percent: z.number().optional(),
  customKind: z.string().optional(),
  customData: z.unknown().optional(),
})

export const toolCallFrameSchema = z.object({
  kind: z.literal('tool'),
  frameId: frameIdSchema,
  toolCallId: z.string(),
  name: z.string(),
  state: z.enum(['running', 'done', 'error']),
  input: z.unknown().optional(),
  intent: z.string().optional(),
  inputPending: z.literal(true).optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  progress: toolFrameProgressSchema.optional(),
  taskId: taskIdSchema.optional(),
  approvalId: z.string().optional(),
  todoId: z.string().optional(),
  agentRefs: z.array(agentRefSchema).optional(),
})

const interactionBase = {
  interactionId: z.string(),
  toolCallId: z.string().optional(),
  state: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'answered', 'dismissed']),
}

export const interactionQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  multiple: z.boolean(),
  allowCustom: z.boolean(),
  options: z.array(z.object({ id: z.string().min(1), label: z.string(), description: z.string().optional() })),
})

export const interactionSchema = z.discriminatedUnion('interactionKind', [
  z.object({
    ...interactionBase,
    interactionKind: z.literal('approval'),
    request: z.object({
      toolName: z.string(),
      title: z.string(),
      detail: z.string(),
      allowSessionScope: z.boolean(),
    }),
    response: z
      .object({
        decision: z.enum(['approve', 'reject']),
        scope: z.enum(['once', 'session']),
        feedback: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    ...interactionBase,
    interactionKind: z.literal('plan'),
    request: z.object({ title: z.string(), planFilePath: z.string(), planMarkdown: z.string() }),
    response: z
      .object({ decision: z.enum(['approve', 'reject', 'revise']), feedback: z.string().optional() })
      .optional(),
  }),
  z.object({
    ...interactionBase,
    interactionKind: z.literal('question'),
    request: z.object({ questions: z.array(interactionQuestionSchema) }),
    response: z
      .object({
        answers: z.record(z.string(), z.object({ selected: z.array(z.string()), custom: z.string().optional() })),
      })
      .optional(),
  }),
  z.object({
    ...interactionBase,
    interactionKind: z.literal('confirm'),
    request: z.object({ title: z.string(), message: z.string() }),
    response: z.object({ value: z.boolean() }).optional(),
  }),
  z.object({
    ...interactionBase,
    interactionKind: z.literal('select'),
    request: z.object({ title: z.string(), options: z.array(z.string()) }),
    response: z.object({ value: z.string().optional() }).optional(),
  }),
  z.object({
    ...interactionBase,
    interactionKind: z.literal('input'),
    request: z.object({ title: z.string(), placeholder: z.string().optional(), multiline: z.boolean() }),
    response: z.object({ value: z.string().optional() }).optional(),
  }),
])

export const noticeFrameSchema = z.object({
  kind: z.literal('notice'),
  frameId: frameIdSchema,
  level: z.enum(['error', 'warning', 'info']),
  source: z.string().optional(),
  message: z.string(),
  detail: z.unknown().optional(),
})

export const transcriptFrameSchema = z.discriminatedUnion('kind', [
  textFrameSchema,
  thinkingFrameSchema,
  toolCallFrameSchema,
  noticeFrameSchema,
])

export const transcriptStepSchema = z.object({
  kind: z.literal('step'),
  stepId: stepIdSchema,
  turnId: turnIdSchema,
  ordinal: z.number().int(),
  state: stepStateSchema,
  frames: z.array(transcriptFrameSchema),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  usage: stepUsageSchema.optional(),
  finishReason: z.string().optional(),
  timing: stepTimingSchema.optional(),
  retry: stepRetrySchema.optional(),
  endReason: z.string().optional(),
  endMessage: z.string().optional(),
})

export const transcriptTurnSchema = z.object({
  kind: z.literal('turn'),
  turnId: turnIdSchema,
  triggerPromptId: z.string().min(1).optional(),
  ordinal: z.number().int(),
  state: turnStateSchema,
  origin: turnOriginSchema,
  prompt: z.string().optional(),
  attachmentIds: z.array(z.string()).optional(),
  clientTurnId: z.string().min(1).optional(),
  steps: z.array(transcriptStepSchema),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  usage: transcriptUsageSchema.optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
})

export const transcriptMarkerSchema = z.object({
  kind: z.literal('marker'),
  markerId: z.string(),
  marker: z.string(),
  payload: z.unknown().optional(),
  at: z.string().optional(),
})

export const transcriptTaskRefSchema = z.object({
  kind: z.literal('taskref'),
  refId: z.string(),
  taskId: taskIdSchema,
  at: z.string().optional(),
})

export const transcriptItemSchema = z.discriminatedUnion('kind', [
  transcriptTurnSchema,
  transcriptMarkerSchema,
  transcriptTaskRefSchema,
])

export const transcriptTaskSchema = z.object({
  taskId: taskIdSchema,
  kind: z.enum(['shell', 'subagent', 'tool', 'other']),
  state: z.enum(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
  detached: z.boolean(),
  description: z.string().optional(),
  agentId: agentIdSchema.optional(),
  outputTail: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  stateReason: z.string().optional(),
  usage: stepUsageSchema.optional(),
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
})

export const goalMetaSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  completionCriterion: z.string().optional(),
  budgetUsed: z.number().optional(),
  budgetLimit: z.number().optional(),
})

export const modesMetaSchema = z.object({
  plan: z.object({ reviewPath: z.string().optional(), version: z.number().optional() }).optional(),
  swarm: z.object({ trigger: z.string().optional() }).optional(),
  tower: z.object({}).optional(),
})

export const modesMetaMergeSchema = z.object({
  plan: z.object({ reviewPath: z.string().optional(), version: z.number().optional() }).nullable().optional(),
  swarm: z.object({ trigger: z.string().optional() }).nullable().optional(),
  tower: z.object({}).nullable().optional(),
})

export const agentPhaseMetaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({
    kind: z.literal('running'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('streaming'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    stream: z.enum(['assistant', 'thinking', 'tool_call']),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('tool_call'),
    turnId: z.number(),
    step: z.number(),
    toolCallId: z.string(),
    name: z.string(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('retrying'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    failedAttempt: z.number(),
    nextAttempt: z.number(),
    maxAttempts: z.number(),
    delayMs: z.number(),
    errorName: z.string().optional(),
    statusCode: z.number().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('awaiting_approval'),
    turnId: z.number(),
    step: z.number().optional(),
    approval: z.unknown().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('interrupted'),
    turnId: z.number(),
    step: z.number().optional(),
    reason: z.enum(['aborted', 'max_steps', 'error']),
    message: z.string().optional(),
    at: z.number(),
  }),
  z.object({
    kind: z.literal('ended'),
    turnId: z.number(),
    reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
    durationMs: z.number().optional(),
    at: z.number(),
  }),
])

export const agentUsageMetaSchema = z.object({
  byModel: z.record(z.string(), stepUsageSchema).optional(),
  currentTurn: stepUsageSchema.optional(),
  total: stepUsageSchema.optional(),
})

export const agentStatusMetaSchema = z.object({
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  usage: agentUsageMetaSchema.optional(),
  contextTokens: z.number().optional(),
  maxContextTokens: z.number().optional(),
  contextUsage: z.number().optional(),
  permission: z.enum(['manual', 'yolo', 'auto']).optional(),
  phase: agentPhaseMetaSchema.optional(),
})

export const transcriptMetaSchema = z.object({
  goal: goalMetaSchema.optional(),
  modes: modesMetaSchema.optional(),
  activity: z.enum(['idle', 'turn', 'disposing', 'unknown']).optional(),
  agent: agentStatusMetaSchema.optional(),
})

export const transcriptMetaMergeSchema = transcriptMetaSchema.extend({
  goal: goalMetaSchema.nullable().optional(),
  modes: modesMetaMergeSchema.optional(),
})

export const attachmentSchema = z.object({
  attachmentId: z.string(),
  mediaType: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  /* 只收内容寻址的地址：data URL / 任意 URL 进不了契约（见 model/attachment.ts） */
  source: z.object({ kind: z.literal('blob'), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  placeholder: z.string().optional(),
})

export const todoItemSchema = z.object({
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done']),
})

export const todoSchema = z.object({
  todoId: z.string(),
  items: z.array(todoItemSchema),
  updatedAt: z.string().optional(),
})

export const transcriptPromptSchema = z.object({
  promptId: z.string(),
  status: z.enum(['running', 'queued', 'blocked', 'completed', 'failed', 'aborted']),
  userMessageId: z.string().optional(),
  content: z.unknown().optional(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  steeredAt: z.string().optional(),
})

export const agentTranscriptSnapshotSchema = z.object({
  items: z.array(transcriptItemSchema),
  tasks: z.array(transcriptTaskSchema),
  interactions: z.array(interactionSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
  todos: z.array(todoSchema).default([]),
  prompts: z.array(transcriptPromptSchema).default([]),
  meta: transcriptMetaSchema,
  hasMoreOlder: z.boolean().optional(),
})

export const turnHeaderSchema = transcriptTurnSchema.omit({ steps: true })
export const stepHeaderSchema = transcriptStepSchema.omit({ frames: true })

export const appendTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('frame'),
    turnId: turnIdSchema,
    stepId: stepIdSchema,
    frameId: frameIdSchema,
  }),
  z.object({ type: z.literal('task'), taskId: taskIdSchema }),
])

export const transcriptOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('reset'),
    agentId: agentIdSchema,
    snapshot: agentTranscriptSnapshotSchema,
  }),
  z.object({ op: z.literal('turn.upsert'), turn: turnHeaderSchema }),
  z.object({ op: z.literal('step.upsert'), turnId: turnIdSchema, step: stepHeaderSchema }),
  z.object({
    op: z.literal('frame.upsert'),
    turnId: turnIdSchema,
    stepId: stepIdSchema,
    frame: transcriptFrameSchema,
  }),
  z.object({
    op: z.literal('append'),
    target: appendTargetSchema,
    offset: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    op: z.literal('marker.upsert'),
    item: transcriptMarkerSchema,
    beforeTurn: z.number().int().optional(),
  }),
  z.object({
    op: z.literal('taskref.upsert'),
    item: transcriptTaskRefSchema,
    beforeTurn: z.number().int().optional(),
  }),
  z.object({ op: z.literal('task.upsert'), task: transcriptTaskSchema }),
  z.object({ op: z.literal('interaction.upsert'), interaction: interactionSchema }),
  z.object({ op: z.literal('attachment.upsert'), attachment: attachmentSchema }),
  z.object({ op: z.literal('todo.upsert'), todo: todoSchema }),
  z.object({ op: z.literal('prompt.upsert'), prompt: transcriptPromptSchema }),
  z.object({ op: z.literal('meta.merge'), meta: transcriptMetaMergeSchema }),
  z.object({ op: z.literal('items.remove'), ids: z.array(z.string()) }),
])
