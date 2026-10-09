import type { z } from 'zod'

import {
  agentPhaseMetaSchema,
  agentStatusMetaSchema,
  agentTranscriptSnapshotSchema,
  attachmentSchema,
  goalMetaSchema,
  interactionSchema,
  modesMetaMergeSchema,
  modesMetaSchema,
  noticeFrameSchema,
  stepRetrySchema,
  stepTimingSchema,
  stepUsageSchema,
  thinkingFrameSchema,
  todoSchema,
  toolCallFrameSchema,
  transcriptFrameSchema,
  transcriptItemSchema,
  transcriptMarkerSchema,
  transcriptMetaMergeSchema,
  transcriptMetaSchema,
  transcriptOperationSchema,
  transcriptPromptSchema,
  transcriptStepSchema,
  transcriptTaskRefSchema,
  transcriptTaskSchema,
  transcriptTurnSchema,
  transcriptUsageSchema,
} from './schema'

import type { TranscriptAttachment } from '../model/attachment'
import type { TranscriptFrame } from '../model/frame'
import type { TranscriptInteraction } from '../model/interaction'
import type { TranscriptMarker, TranscriptItem, TranscriptTaskRef } from '../model/item'
import type {
  AgentPhaseMeta,
  AgentStatusMeta,
  GoalMeta,
  ModesMeta,
  ModesMetaMerge,
  TranscriptMeta,
  TranscriptMetaMerge,
} from '../model/meta'
import type { TranscriptPrompt } from '../model/prompt'
import type { TranscriptTask } from '../model/task'
import type { TranscriptTodo } from '../model/todo'
import type { StepRetry, StepTiming, StepUsage, TranscriptStep, TranscriptTurn, TranscriptUsage } from '../model/turn'
import type { AgentTranscriptSnapshot, TranscriptOperation } from '../ops/operation'

/*
 * 线上形状与消费侧读法是两份定义：schema.ts 认字节，model/ 说类型。它们必须同形，
 * 否则「schema 校验通过」就不再蕴含「这是合法的 model」—— 校验形同虚设。
 *
 * 这里只用类型：一行运行时都不会产生。判据是单向的 —— schema 的输出必须能当 model 用，
 * 那是校验的意义所在；反方向不成立（model 的 readonly 数组不是 schema 的输入）。
 *
 * 这个文件刻意不出现在 index.ts：它是编译期断言，不是包的公开面。
 */

type IsAssignable<From, To> = [From] extends [To] ? true : false
type Expect<T extends true> = T

type Wire<T extends z.ZodType> = z.infer<T>

export type ParityChecks = [
  Expect<IsAssignable<Wire<typeof transcriptUsageSchema>, TranscriptUsage>>,
  Expect<IsAssignable<Wire<typeof stepUsageSchema>, StepUsage>>,
  Expect<IsAssignable<Wire<typeof stepTimingSchema>, StepTiming>>,
  Expect<IsAssignable<Wire<typeof stepRetrySchema>, StepRetry>>,
  Expect<IsAssignable<Wire<typeof transcriptFrameSchema>, TranscriptFrame>>,
  Expect<IsAssignable<Wire<typeof thinkingFrameSchema>, Extract<TranscriptFrame, { kind: 'thinking' }>>>,
  Expect<IsAssignable<Wire<typeof toolCallFrameSchema>, Extract<TranscriptFrame, { kind: 'tool' }>>>,
  Expect<IsAssignable<Wire<typeof noticeFrameSchema>, Extract<TranscriptFrame, { kind: 'notice' }>>>,
  Expect<IsAssignable<Wire<typeof transcriptStepSchema>, TranscriptStep>>,
  Expect<IsAssignable<Wire<typeof transcriptTurnSchema>, TranscriptTurn>>,
  Expect<IsAssignable<Wire<typeof transcriptMarkerSchema>, TranscriptMarker>>,
  Expect<IsAssignable<Wire<typeof transcriptTaskRefSchema>, TranscriptTaskRef>>,
  Expect<IsAssignable<Wire<typeof transcriptItemSchema>, TranscriptItem>>,
  Expect<IsAssignable<Wire<typeof transcriptTaskSchema>, TranscriptTask>>,
  Expect<IsAssignable<Wire<typeof interactionSchema>, TranscriptInteraction>>,
  Expect<IsAssignable<Wire<typeof attachmentSchema>, TranscriptAttachment>>,
  Expect<IsAssignable<Wire<typeof todoSchema>, TranscriptTodo>>,
  Expect<IsAssignable<Wire<typeof transcriptPromptSchema>, TranscriptPrompt>>,
  Expect<IsAssignable<Wire<typeof goalMetaSchema>, GoalMeta>>,
  Expect<IsAssignable<Wire<typeof modesMetaSchema>, ModesMeta>>,
  Expect<IsAssignable<Wire<typeof modesMetaMergeSchema>, ModesMetaMerge>>,
  Expect<IsAssignable<Wire<typeof agentPhaseMetaSchema>, AgentPhaseMeta>>,
  Expect<IsAssignable<Wire<typeof agentStatusMetaSchema>, AgentStatusMeta>>,
  Expect<IsAssignable<Wire<typeof transcriptMetaSchema>, TranscriptMeta>>,
  Expect<IsAssignable<Wire<typeof transcriptMetaMergeSchema>, TranscriptMetaMerge>>,
  Expect<IsAssignable<Wire<typeof agentTranscriptSnapshotSchema>, AgentTranscriptSnapshot>>,
  Expect<IsAssignable<Wire<typeof transcriptOperationSchema>, TranscriptOperation>>,
]
