import { ModelRef, Posture } from '@poietica/engine'
import { z } from 'zod'

export const Schedule = z.object({
  cron: z.string().trim().min(1).nullable(),
  at: z.number().int().nullable().default(null),
  timeZone: z.string().min(1),
})
export type Schedule = z.infer<typeof Schedule>

export const ScheduleProblem = z.enum(['unreadable', 'never_runs', 'too_frequent', 'time_zone', 'in_past', 'conflict'])
export type ScheduleProblem = z.infer<typeof ScheduleProblem>

export const ThreadMode = z.enum(['new', 'continue'])
export type ThreadMode = z.infer<typeof ThreadMode>

/** attention 只在失败、等批准、超时或 agent 标了 attention 时；never 从不（运行记录照写）。 */
export const NotifyPolicy = z.enum(['always', 'attention', 'never'])
export type NotifyPolicy = z.infer<typeof NotifyPolicy>

/* 字段表只写一次，**不带默认值**：更新用的 patch 必须由它 .partial() 得来。zod 4 会在 .partial() 里照样套用 .default()，实测
 * `AutomationDraft.partial().parse({title})` 得到 posture:'auto-edit', model:null, thinking:null，只改标题的更新会把其余一并冲回默认。 */
const automationFields = {
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  schedule: Schedule,
  workspaceId: z.string(),
  posture: Posture,
  model: ModelRef.nullable(),
  thinking: z.string().nullable(),
  threadMode: ThreadMode,
  threadId: z.string().min(1).nullable(),
  notify: NotifyPolicy,
  catchUp: z.boolean(),
}

export const AutomationDraft = z.object({
  ...automationFields,
  posture: automationFields.posture.default('auto-edit'),
  model: automationFields.model.default(null),
  thinking: automationFields.thinking.default(null),
  threadMode: automationFields.threadMode.default('new'),
  threadId: automationFields.threadId.default(null),
  notify: automationFields.notify.default('attention'),
  catchUp: automationFields.catchUp.default(true),
})
export type AutomationDraft = z.infer<typeof AutomationDraft>

export const AutomationPatch = z.object(automationFields).partial()
export type AutomationPatch = z.infer<typeof AutomationPatch>

export const RunOutcome = z.enum(['running', 'awaiting', 'succeeded', 'failed', 'cancelled', 'skipped'])
export type RunOutcome = z.infer<typeof RunOutcome>

export const RunTrigger = z.enum(['schedule', 'manual', 'catch_up'])
export type RunTrigger = z.infer<typeof RunTrigger>

export const AutomationRun = z.object({
  id: z.string(),
  automationId: z.string(),
  threadId: z.string().nullable(),
  trigger: RunTrigger,
  scheduledFor: z.number().int().nullable(),
  startedAt: z.number().int(),
  settledAt: z.number().int().nullable(),
  outcome: RunOutcome,
  message: z.string().nullable(),
  summary: z.string().nullable(),
  attention: z.boolean(),
})
export type AutomationRun = z.infer<typeof AutomationRun>

export const Automation = AutomationDraft.extend({
  id: z.string(),
  enabled: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  nextRunAt: z.number().int().nullable(),
  issue: z.string().nullable(),
  lastRun: AutomationRun.nullable(),
})
export type Automation = z.infer<typeof Automation>

export const AutomationAttention = z.object({
  automationId: z.string(),
  runId: z.string(),
  threadId: z.string().nullable(),
  title: z.string(),
  body: z.string(),
})
export type AutomationAttention = z.infer<typeof AutomationAttention>
