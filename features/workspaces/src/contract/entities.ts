import { z } from 'zod'

export const WorkspaceId = z.string().min(1)

export const Workspace = z.object({
  id: WorkspaceId,
  kind: z.enum(['folder', 'scratch']),
  path: z.string(),
  name: z.string(),
  createdAt: z.number().int(),
  lastOpenedAt: z.number().int(),
  exists: z.boolean(), // list 时实时检查目录是否存在（不存在时 UI 显示灰色并提示）
})
export type Workspace = z.infer<typeof Workspace>
