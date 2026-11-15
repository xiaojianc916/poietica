import { z } from 'zod'

export const WorkspaceId = z.string().min(1)

export const Workspace = z.object({
  id: WorkspaceId,
  path: z.string(),
  name: z.string(),
  createdAt: z.number().int(),
  lastOpenedAt: z.number().int(),
  exists: z.boolean(), // list 时实时检查目录是否存在（不存在时 UI 显示灰色并提示）
  /** local = 直接在用户目录；isolated = 独立 worktree（§14.1）。老载荷缺省按 local。 */
  mode: z.enum(['local', 'isolated']).optional(),
  /** 隔离工作区的主仓库路径；local 为 null。 */
  sourcePath: z.string().nullable().optional(),
  /** 创建隔离工作区时的基线提交 / 分支。 */
  baseRef: z.string().nullable().optional(),
  /** 隔离工作区分支名；local 为 null。 */
  branch: z.string().nullable().optional(),
})
export type Workspace = z.infer<typeof Workspace>
