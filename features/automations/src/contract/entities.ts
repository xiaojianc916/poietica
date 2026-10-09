// automations 的 zod 实体（07 页 §9B 完整代码）
import { ModelRef, Posture } from '@poietica/engine'
import { z } from 'zod'

/** cron 为 null 表示“只手动运行”；时区为 IANA 名称，例如 'Asia/Shanghai' */
export const Schedule = z.object({ cron: z.string().trim().min(1).nullable(), timeZone: z.string().min(1) })
export type Schedule = z.infer<typeof Schedule>

export const ScheduleProblem = z.enum(['unreadable', 'never_runs', 'too_frequent', 'time_zone'])
export type ScheduleProblem = z.infer<typeof ScheduleProblem>

export const AutomationDraft = z.object({
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  schedule: Schedule,
  workspaceId: z.string(),
  posture: Posture.default('auto-edit'),
  model: ModelRef.nullable().default(null),
  thinking: z.string().nullable().default(null),
})
export type AutomationDraft = z.infer<typeof AutomationDraft>

export const RunOutcome = z.enum(['running', 'awaiting', 'succeeded', 'failed', 'cancelled'])
export type RunOutcome = z.infer<typeof RunOutcome>

export const AutomationRun = z.object({
  id: z.string(),
  automationId: z.string(),
  threadId: z.string().nullable(),
  trigger: z.enum(['schedule', 'manual']),
  scheduledFor: z.number().int().nullable(),
  startedAt: z.number().int(),
  settledAt: z.number().int().nullable(),
  outcome: RunOutcome,
  message: z.string().nullable(),
})
export type AutomationRun = z.infer<typeof AutomationRun>

export const Automation = AutomationDraft.extend({
  id: z.string(),
  enabled: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  nextRunAt: z.number().int().nullable(),
  /** 计划有问题或工作区不可用时的说明；有 issue 的任务不会被调度 */
  issue: z.string().nullable(),
  lastRun: AutomationRun.nullable(),
})
export type Automation = z.infer<typeof Automation>
