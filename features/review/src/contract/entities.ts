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

/* ── GitHub 侧的实体：代码审查页的事实源 ────────────────────────────────────────────────
 * 这些字段与 GitHub 的 REST/GraphQL 形状一一对应（读法在 core/github），UI 只认这里的名字。
 * 「不是 GitHub 仓库」不是错误：availability.available=false + reason 说明为什么。 */

export const GithubAvailability = z.object({
  available: z.boolean(),
  /** 不可用的原因（没装 gh / 没登录 / 读不到），可用时为 null。 */
  reason: z.string().nullable(),
  /** 当前 gh 登录的账号，未登录或不可用时为 null。 */
  login: z.string().nullable(),
})
export type GithubAvailability = z.infer<typeof GithubAvailability>

/** 仓库的 GitHub 身份；远端不是 GitHub 时为 null。 */
export const GithubRepository = z.object({
  owner: z.string(),
  name: z.string(),
  /** owner/name，列表与详情顶栏都用它。 */
  fullName: z.string(),
  url: z.string(),
})
export type GithubRepository = z.infer<typeof GithubRepository>

export const GithubPullState = z.enum(['open', 'merged', 'closed'])
export type GithubPullState = z.infer<typeof GithubPullState>

/** 合并可行性：GitHub 的 mergeable × mergeStateStatus 归到这几档，UI 不自己推。 */
export const GithubMergeStatus = z.enum(['clean', 'conflicting', 'blocked', 'behind', 'draft', 'unknown'])
export type GithubMergeStatus = z.infer<typeof GithubMergeStatus>

export const GithubCheckState = z.enum(['success', 'failure', 'pending', 'neutral', 'skipped'])
export type GithubCheckState = z.infer<typeof GithubCheckState>

export const GithubCheck = z.object({
  name: z.string(),
  state: GithubCheckState,
})
export type GithubCheck = z.infer<typeof GithubCheck>

export const GithubReviewState = z.enum(['approved', 'changes_requested', 'review_required', 'none'])
export type GithubReviewState = z.infer<typeof GithubReviewState>

/*
 * 列表里的一行：只有画列表行、搜索、过滤要的那几样。正文、检查项、评审结论、改动计数都不在这里 ——
 * 它们只在打开某一条时按需读（github.pullRequest）。列表若带着它们，进页面就得等 GitHub 把每一条的
 * 正文、检查项与合并状态都算一遍（以前就是这样：进页面慢，点开却是「已经加载好的」）。
 */
export const GithubPullSummary = z.object({
  number: z.number().int(),
  title: z.string(),
  state: GithubPullState,
  /** GitHub 的 isDraft：state 仍是 open，但语义是草稿。 */
  draft: z.boolean(),
  author: z.string(),
  avatarUrl: z.string().nullable(),
  /** ISO 8601。相对时间在 UI 侧格式化。 */
  createdAt: z.string(),
  /** 详情缓存拿它判断「这一条在 GitHub 上变过没有」。 */
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  headBranch: z.string(),
  baseBranch: z.string(),
  /**
   * 列表行的状态字形要知道「有没有冲突」。列表里只按 mergeable 粗分（clean / conflicting / draft / unknown）；
   * blocked / behind 这些要 GitHub 现算 mergeStateStatus 的档位只在详情里有。
   */
  mergeStatus: GithubMergeStatus,
  url: z.string(),
})
export type GithubPullSummary = z.infer<typeof GithubPullSummary>

/** 一条 PR 的全部：列表那一行的字段，加上详情才要的正文、计数、检查项与评审结论。 */
export const GithubPullRequest = GithubPullSummary.extend({
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  commits: z.number().int(),
  /** 评论条数（含 review 评论）。 */
  comments: z.number().int(),
  reviews: z.number().int(),
  reviewState: GithubReviewState,
  /** PR 正文的 Markdown（没写就是空串）。 */
  body: z.string(),
  labels: z.array(z.string()),
  checks: z.array(GithubCheck),
})
export type GithubPullRequest = z.infer<typeof GithubPullRequest>

/** 时间线上的一条：正文评论，或一条评审结论。 */
export const GithubComment = z.object({
  id: z.string(),
  kind: z.enum(['comment', 'review']),
  author: z.string(),
  avatarUrl: z.string().nullable(),
  /** 正文 Markdown；review 的结论行可以为空。 */
  body: z.string(),
  createdAt: z.string(),
  /** 只有 kind='review' 有：这条评审的结论。 */
  reviewState: GithubReviewState.nullable(),
})
export type GithubComment = z.infer<typeof GithubComment>

export const GithubMergeMethod = z.enum(['merge', 'squash', 'rebase'])
export type GithubMergeMethod = z.infer<typeof GithubMergeMethod>
