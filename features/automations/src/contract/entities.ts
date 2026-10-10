// automations 的 zod 实体（07 页 §9B 完整代码；审查 R-14 扩展：一次性计划、续用对话、通知、补跑、运行摘要）
import { ModelRef, Posture } from '@poietica/engine'
import { z } from 'zod'

/**
 * 计划：三选一。
 *   - cron 非空：周期任务（crontab 表达式，按 timeZone 解释）；
 *   - at 非空：一次性任务（毫秒时间戳），跑过一次后任务自动停用；
 *   - 两者都是 null：只手动运行。
 * cron 与 at 同时非空是无效计划（conflict）。时区为 IANA 名称，例如 'Asia/Shanghai'。
 */
export const Schedule = z.object({
  cron: z.string().trim().min(1).nullable(),
  at: z.number().int().nullable().default(null),
  timeZone: z.string().min(1),
})
export type Schedule = z.infer<typeof Schedule>

export const ScheduleProblem = z.enum(['unreadable', 'never_runs', 'too_frequent', 'time_zone', 'in_past', 'conflict'])
export type ScheduleProblem = z.infer<typeof ScheduleProblem>

/** 每次运行开在哪条对话里：new = 每次新开一条；continue = 续用同一条（有上下文记忆） */
export const ThreadMode = z.enum(['new', 'continue'])
export type ThreadMode = z.infer<typeof ThreadMode>

/**
 * 运行结束后要不要发系统通知。
 *   - always：每次结束都通知（失败、等批准也通知）；
 *   - attention：只在失败、等批准、超时，或 agent 汇报时标了 attention 时通知；
 *   - never：从不通知（运行记录照写）。
 */
export const NotifyPolicy = z.enum(['always', 'attention', 'never'])
export type NotifyPolicy = z.infer<typeof NotifyPolicy>

/*
 * 字段表只写一次，**不带默认值**：更新用的 patch 必须由它 .partial() 得来。
 * zod 4 会在 .partial() 里照样套用 .default()（实测 `AutomationDraft.partial().parse({title})`
 * 得到 posture:'auto-edit', model:null, thinking:null），只改标题的更新会把模型、思考强度、
 * 姿态一并冲回默认 —— 审查 R-14 修的就是这一条。
 */
const automationFields = {
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  schedule: Schedule,
  workspaceId: z.string(),
  posture: Posture,
  model: ModelRef.nullable(),
  thinking: z.string().nullable(),
  threadMode: ThreadMode,
  /** threadMode 为 continue 时续用的那条对话；null = 下一次运行新建一条并记下来 */
  threadId: z.string().min(1).nullable(),
  notify: NotifyPolicy,
  /** 应用没开着时错过了计划时间：下次启动后补跑一次（true）还是记一条「错过」跳过（false） */
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

/** 更新用的一格 patch：缺席的键 = 不改（没有默认值，见上） */
export const AutomationPatch = z.object(automationFields).partial()
export type AutomationPatch = z.infer<typeof AutomationPatch>

/** skipped：到点了但没有跑（上一次还没结束，或应用当时没开且任务不补跑） */
export const RunOutcome = z.enum(['running', 'awaiting', 'succeeded', 'failed', 'cancelled', 'skipped'])
export type RunOutcome = z.infer<typeof RunOutcome>

/** catch_up：应用没开着时错过的那一次，启动后补跑 */
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
  /** 失败 / 跳过 / 取消的原因（给人看的中文） */
  message: z.string().nullable(),
  /** agent 用 automation_report 交的一两句结论；没交是 null */
  summary: z.string().nullable(),
  /** agent 汇报时标了「需要用户关注」 */
  attention: z.boolean(),
})
export type AutomationRun = z.infer<typeof AutomationRun>

export const Automation = AutomationDraft.extend({
  id: z.string(),
  enabled: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  nextRunAt: z.number().int().nullable(),
  /** 计划本身有问题时的说明（读不懂、时区无效、一次性时间已过）；有 issue 的任务不会被调度 */
  issue: z.string().nullable(),
  lastRun: AutomationRun.nullable(),
})
export type Automation = z.infer<typeof Automation>

/** 一条要弹成系统通知的消息：Core 按任务的通知策略判定，UI 只负责转给系统 */
export const AutomationAttention = z.object({
  automationId: z.string(),
  runId: z.string(),
  threadId: z.string().nullable(),
  title: z.string(),
  body: z.string(),
})
export type AutomationAttention = z.infer<typeof AutomationAttention>
