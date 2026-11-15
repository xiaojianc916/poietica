import { z } from 'zod'

/** 审计视图按事实类别取 Journal 事件，不另存一份。 */
export const AuditKind = z.enum(['policy', 'approval', 'checkpoint', 'run'])
export type AuditKind = z.infer<typeof AuditKind>

/** 工具分类的风险等级（与 policy 的分类表同一套取值）。 */
export const AuditRisk = z.enum(['none', 'low', 'medium', 'high'])
export type AuditRisk = z.infer<typeof AuditRisk>

/**
 * 一次审计查询。全部条件都是与关系：给的越多范围越窄。
 * - `threadId` 不给 = 跨线程（审计页的默认问法）；
 * - `tool` / `risk` / `workspaceRoot` 只在策略类事件上有意义，其它类别不会被它们筛掉（条件只对带该字段的事件生效）。
 */
export const AuditFilter = z.object({
  threadId: z.string().min(1).optional(),
  kinds: z.array(AuditKind).optional(),
  /** 工具名（omp 的工具名，例如 bash / apply_patch） */
  tool: z.string().min(1).optional(),
  risk: AuditRisk.optional(),
  workspaceRoot: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
})
export type AuditFilter = z.infer<typeof AuditFilter>

export const AuditEntry = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  at: z.string(),
  /** 这条事件属于哪个线程；跨线程查询时用它分组 */
  threadId: z.string().optional(),
  /** 原样事件：审计页按 type 渲染，不用为每种事件再抄一份字段。 */
  event: z.unknown(),
})
export type AuditEntry = z.infer<typeof AuditEntry>

export const AuditQueryResult = z.object({ entries: z.array(AuditEntry) })
export type AuditQueryResult = z.infer<typeof AuditQueryResult>
