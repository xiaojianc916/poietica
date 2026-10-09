// review 的 zod 实体（07 页 §10B）
import { z } from 'zod'

export const FileChange = z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted'])
export type FileChange = z.infer<typeof FileChange>

export const ChangeEntry = z.object({
  path: z.string(),
  change: FileChange,
  oldPath: z.string().nullable(),
})
export type ChangeEntry = z.infer<typeof ChangeEntry>

export const GitStatus = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(), // null：HEAD 分离
  detachedAt: z.string().nullable(), // HEAD 分离时的短提交号
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  staged: z.array(ChangeEntry),
  unstaged: z.array(ChangeEntry),
})
export type GitStatus = z.infer<typeof GitStatus>

export const GitBranch = z.object({
  name: z.string(),
  isCurrent: z.boolean(),
  upstream: z.string().nullable(),
  lastCommitAt: z.number().int().nullable(),
})
export type GitBranch = z.infer<typeof GitBranch>

export const ReviewFile = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  change: FileChange,
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
})
export type ReviewFile = z.infer<typeof ReviewFile>
