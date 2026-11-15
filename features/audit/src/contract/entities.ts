import { z } from 'zod'

/** 审计视图按事实类别取 Journal 事件，不另存一份。 */
export const AuditKind = z.enum(['policy', 'approval', 'checkpoint', 'run'])
export type AuditKind = z.infer<typeof AuditKind>

export const AuditEntry = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  at: z.string(),
  /** 原样事件：审计页按 type 渲染，不用为每种事件再抄一份字段。 */
  event: z.unknown(),
})
export type AuditEntry = z.infer<typeof AuditEntry>

export const AuditQueryResult = z.object({ entries: z.array(AuditEntry) })
export type AuditQueryResult = z.infer<typeof AuditQueryResult>
