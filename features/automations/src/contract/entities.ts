import { ModelRef, Posture } from '@poietica/runtime-protocol'
import { z } from 'zod'

/** 自定义重复的权威规则；cron 只是兼容展示。unit 与 ZCode 的 intervalUnit 同集。 */
export const ScheduleUnit = z.enum(['minute', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'])
export type ScheduleUnit = z.infer<typeof ScheduleUnit>

const weekday = z.number().int().min(1).max(7)

export const ScheduleRule = z.object({
  unit: ScheduleUnit,
  interval: z.number().int().min(1).max(200),
  /** daily 及以上用；minute/hours 规则里只作展示。 */
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  /** 创建/修改时刻：分钟间隔从它起算，其它单位用它定日历锚点。 */
  anchorAt: z.number().int(),
  /** ISO 1=周一 … 7=周日；weekly 多选，monthly 的 weekday 模式取第一项。 */
  weekdays: z.array(weekday).optional(),
  monthDays: z.array(z.number().int().min(1).max(31)).optional(),
  /** 1-12；yearly 取第一项。 */
  months: z.array(z.number().int().min(1).max(12)).optional(),
  monthlyMode: z.enum(['date', 'weekday']).optional(),
})
export type ScheduleRule = z.infer<typeof ScheduleRule>

export const Schedule = z.object({
  cron: z.string().trim().min(1).nullable(),
  at: z.number().int().nullable().default(null),
  timeZone: z.string().min(1),
  /** 缺省表示没有自定义规则；编辑器的存盘不带它，由服务层按「计划没改就保留」处理。 */
  rule: ScheduleRule.nullable().optional(),
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
  /** 最多成功派发几次；null = 不限。 */
  maxRuns: z.number().int().positive().nullable().optional(),
  /** 截止时刻；下一次超过它就停用。null = 不截止。 */
  endAt: z.number().int().nullable().optional(),
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

/** 任务级派发阶段：idle 可认领，claimed 被某次 tick 持有，dispatched 已交给会话，failed_to_dispatch 等退避重试。 */
export const AutomationDispatch = z.enum(['idle', 'claimed', 'dispatched', 'failed_to_dispatch'])
export type AutomationDispatch = z.infer<typeof AutomationDispatch>

/** 运行级派发阶段：与任务级分开记账，迟到结算只影响这一条运行。 */
export const RunDispatch = z.enum(['claimed', 'dispatched', 'failed_to_dispatch'])
export type RunDispatch = z.infer<typeof RunDispatch>

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
  dispatchStatus: RunDispatch,
  attempts: z.number().int().nonnegative(),
})
export type AutomationRun = z.infer<typeof AutomationRun>

export const Automation = AutomationDraft.extend({
  schedule: Schedule.extend({ rule: ScheduleRule.nullable() }),
  maxRuns: z.number().int().positive().nullable(),
  endAt: z.number().int().nullable(),
  id: z.string(),
  enabled: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  nextRunAt: z.number().int().nullable(),
  issue: z.string().nullable(),
  /** 成功派发的次数；被跳过的窗口不计。 */
  runCount: z.number().int().nonnegative(),
  dispatchStatus: AutomationDispatch,
  dispatchAttempts: z.number().int().nonnegative(),
  retryAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
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
