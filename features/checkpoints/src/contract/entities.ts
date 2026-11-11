import { z } from 'zod'

export const Checkpoint = z.object({
  /** 影子仓库里的提交号 */
  id: z.string().min(1),
  workspaceRoot: z.string().min(1),
  createdAt: z.string(),
  threadId: z.string().optional(),
  runId: z.string().optional(),
  stepId: z.string().optional(),
  /** 打点原因或用户备注 */
  label: z.string().optional(),
})
export type Checkpoint = z.infer<typeof Checkpoint>

export const CheckpointCreateParams = z.object({
  workspaceRoot: z.string().min(1),
  threadId: z.string().optional(),
  runId: z.string().optional(),
  stepId: z.string().optional(),
  label: z.string().optional(),
})
export type CheckpointCreateParams = z.infer<typeof CheckpointCreateParams>

export const CheckpointListParams = z.object({
  workspaceRoot: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
})
export type CheckpointListParams = z.infer<typeof CheckpointListParams>

export const CheckpointDiffParams = z.object({
  workspaceRoot: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
})
export type CheckpointDiffParams = z.infer<typeof CheckpointDiffParams>

export const CheckpointRestoreParams = z.object({
  workspaceRoot: z.string().min(1),
  checkpoint: z.string().min(1),
  /** 只允许显式路径；空数组拒绝，避免误伤整棵树 */
  paths: z.array(z.string().min(1)).min(1),
})
export type CheckpointRestoreParams = z.infer<typeof CheckpointRestoreParams>

export const CheckpointRestoreResult = z.object({
  restored: z.array(z.string()),
})
export type CheckpointRestoreResult = z.infer<typeof CheckpointRestoreResult>
