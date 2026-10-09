import { ModelRef, Posture, SessionState } from '@poietica/engine'
import { z } from 'zod'
import { pageSchema, type WireTranscriptPage } from './wire'

export const ThreadId = z.string().min(1)
export const MAIN_AGENT_ID = 'main'

/** 新线程的默认姿态：threads.create 与 controls.draft 共用这一个值（07 页 §5E）。 */
export const DEFAULT_POSTURE: Posture = 'auto-edit'

export const Thread = z.object({
  id: ThreadId,
  workspaceId: z.string(),
  title: z.string(),
  titleSource: z.enum(['pending', 'auto', 'user']), // pending：还没有发过消息，标题为“新对话”
  posture: Posture,
  origin: z.enum(['user', 'automation']),
  state: SessionState, // 运行时状态；会话不在内存中时为 idle
  hasSession: z.boolean(), // 是否已绑定 omp 会话文件
  forkedFrom: ThreadId.nullable(),
  pinned: z.boolean(),
  archived: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(), // 最后一次活动（排序用）
})
export type Thread = z.infer<typeof Thread>

export const TurnState = z.object({
  threadId: ThreadId,
  state: SessionState,
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  startedAt: z.number().int().nullable(), // 本轮开始时间；idle 时为 null
})
export type TurnState = z.infer<typeof TurnState>

/**
 * 一条提交（用户按了发送）在 Core 里的状态（「Core 即时回显」方案）。
 *
 * 界面**只画 Core 给的数据**：气泡不是界面自己造的，而是 Core 存库后推回来的这条记录。
 * 所以不存在「乐观条目要被谁收掉」这套对账 —— 记录本身随状态前进，同一行原地改写。
 */
export const SubmissionStatus = z.enum(['pending', 'started', 'queued', 'failed'])
export type SubmissionStatus = z.infer<typeof SubmissionStatus>

/** 提交里的一条附件：形状与渲染用户消息要的那几格一致（图片给 previewUrl，文件给 name/size）。 */
export const SubmissionAttachment = z.object({
  id: z.string().min(1),
  name: z.string(),
  mime: z.string(),
  kind: z.enum(['image', 'file']),
  size: z.number().int().nonnegative(),
  previewUrl: z.string().nullable(),
})
export type SubmissionAttachment = z.infer<typeof SubmissionAttachment>

export const SubmissionView = z.object({
  clientTurnId: z.string().min(1),
  threadId: ThreadId,
  text: z.string(),
  attachments: z.array(SubmissionAttachment),
  skills: z.array(z.string()),
  /** 用户选的方式（turn / steer / followUp）；忙时 Core 可能按它改成排队。 */
  deliverAs: z.enum(['turn', 'steer', 'followUp']),
  status: SubmissionStatus,
  /** omp 真的开了这一轮之后才有；`started` 的判据。 */
  turnId: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** 每次变化 +1；界面只接受更大的 rev（三个来源先后无所谓）。 */
  rev: z.number().int().nonnegative(),
  createdAt: z.number().int(),
})
export type SubmissionView = z.infer<typeof SubmissionView>

/*
 * 快照的编译期类型显式写成 @poietica/transcript 的 TranscriptPage。
 *
 * zod 的推断会把可选字段放宽成 `?: T | undefined`，与上游模型的 exactOptionalPropertyTypes
 * 形状不同（而线上跑的就是上游那一份 JSON）。契约结果因此钉在 TranscriptPage 上：运行时仍然是
 * 同一个 zod schema 在 deep-compare 快照与校验，编译期则是三个进程共用的那一份模型。
 */
export interface TimelineSnapshot {
  readonly page: WireTranscriptPage
  readonly epoch: number
  readonly seq: number
  /** 这个线程此刻要画的提交行（pending / failed / 页码外的 started）。 */
  readonly submissions: readonly SubmissionView[]
}

export const TimelineSnapshot: z.ZodType<TimelineSnapshot> = z.object({
  page: pageSchema,
  epoch: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  submissions: z.array(SubmissionView),
}) as unknown as z.ZodType<TimelineSnapshot>

/** threads.create 的可选初始设置（automations 用它指定模型；普通新建只给 workspaceId） */
export const ThreadInit = z.object({
  workspaceId: z.string(),
  posture: Posture.optional(),
  model: ModelRef.optional(),
  thinking: z.string().optional(),
})
export type ThreadInit = z.infer<typeof ThreadInit>
