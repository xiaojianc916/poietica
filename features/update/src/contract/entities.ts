import { z } from 'zod'

/**
 * 应用自动更新的状态。`disabled` 是**更新器缺席**时的固定值；`error` 只带一句给用户看的中文，原始异常进日志。
 */
export const UpdateState = z.object({
  phase: z.enum(['disabled', 'idle', 'checking', 'available', 'downloading', 'ready', 'error']),
  currentVersion: z.string(),
  version: z.string().nullable(),
  notes: z.string().nullable(),
  progress: z.number().min(0).max(1).nullable(),
  error: z.string().nullable(),
  lastCheckedAt: z.number().int().nullable(),
})
export type UpdateState = z.infer<typeof UpdateState>
