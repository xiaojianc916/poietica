import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import {
  GitBranch,
  GithubAvailability,
  GithubComment,
  GithubMergeMethod,
  GithubPullRequest,
  GithubPullSummary,
  GithubRepository,
  GitStatus,
  ReviewFile,
  TurnChanges,
  TurnRewindPreview,
} from './entities'
import { reviewErrors } from './errors'

export * from './entities'
export { reviewErrors } from './errors'

const empty = z.object({})

export const reviewContract = defineContract({
  id: 'review',
  namespaces: ['git', 'github', 'review'],
  methods: [
    defineMethod({
      name: 'git.status',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1) }),
      result: GitStatus,
      description: '工作区仓库状态；不是仓库时 isRepo=false（不报错）',
    }),
    defineMethod({
      name: 'git.branches',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1) }),
      result: z.object({ current: z.string().nullable(), branches: z.array(GitBranch) }),
      description: '本地分支列表',
    }),
    defineMethod({
      name: 'git.switchBranch',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1), branch: z.string().min(1) }),
      result: GitStatus,
      description: '切换分支',
    }),
    defineMethod({
      name: 'git.createBranch',
      owner: 'core',
      params: z.object({
        workspaceId: z.string().min(1),
        branch: z.string().min(1),
        from: z.string().nullable().optional(),
      }),
      result: GitStatus,
      description: '新建并切换分支（同名 → branch_exists）',
    }),
    defineMethod({
      name: 'git.review',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1), base: z.enum(['HEAD', 'index']) }),
      result: z.object({ files: z.array(ReviewFile) }),
      timeoutMs: 60_000,
      description: '改动清单（带每个文件的加减行数）',
    }),
    defineMethod({
      name: 'git.filePatch',
      owner: 'core',
      params: z.object({
        workspaceId: z.string().min(1),
        path: z.string().min(1),
        base: z.enum(['HEAD', 'index']),
      }),
      result: z.object({ patch: z.string() }),
      description: '单个文件的全文补丁',
    }),
    defineMethod({
      name: 'git.stage',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1), paths: z.array(z.string().min(1)) }),
      result: GitStatus,
      description: '暂存这些路径',
    }),
    defineMethod({
      name: 'git.unstage',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1), paths: z.array(z.string().min(1)) }),
      result: GitStatus,
      description: '取消暂存这些路径',
    }),
    defineMethod({
      name: 'git.commit',
      owner: 'core',
      params: z.object({
        workspaceId: z.string().min(1),
        message: z.string(),
        stageAll: z.boolean(),
      }),
      result: z.object({ commit: z.string() }),
      timeoutMs: 60_000,
      description: '提交（message 作为独立参数）；没有可提交内容 → nothing_to_commit',
    }),
    defineMethod({
      name: 'git.watch',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1) }),
      result: empty,
      description: '开始监听（引用计数）',
    }),
    defineMethod({
      name: 'git.unwatch',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1) }),
      result: empty,
      description: '结束监听（引用计数归零才真的停）',
    }),

    defineMethod({
      name: 'github.availability',
      owner: 'core',
      params: empty,
      result: GithubAvailability,
      description: 'gh 是否可用（装了且登录了）；读一次，UI 拿它决定整页的呈现',
    }),
    defineMethod({
      name: 'github.repository',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1) }),
      result: z.object({ repository: GithubRepository.nullable() }),
      timeoutMs: 30_000,
      description: '工作区远端对应的 GitHub 仓库；不是 GitHub 时 repository=null',
    }),
    defineMethod({
      name: 'github.pullRequests',
      owner: 'core',
      params: z.object({
        workspaceId: z.string().min(1),
        /** 关掉的 PR 默认不列（截图里的 All/PRs/Issues 就是这一档）。 */
        includeClosed: z.boolean().optional(),
      }),
      result: z.object({ repository: GithubRepository.nullable(), pulls: z.array(GithubPullSummary) }),
      timeoutMs: 60_000,
      description: '仓库的 pull request 列表（只有列表行的字段；正文、检查项、计数走 github.pullRequest）',
    }),
    defineMethod({
      name: 'github.pullRequest',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1), number: z.number().int().positive() }),
      result: z.object({ pull: GithubPullRequest }),
      timeoutMs: 60_000,
      description: '单个 pull request 的详情（正文 + 检查项）',
    }),
    defineMethod({
      name: 'github.comments',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1), number: z.number().int().positive() }),
      result: z.object({ comments: z.array(GithubComment) }),
      timeoutMs: 60_000,
      description: 'PR 的评论与评审（时间线标签页）',
    }),
    defineMethod({
      name: 'github.comment',
      owner: 'core',
      params: z.object({
        workspaceId: z.string().min(1),
        number: z.number().int().positive(),
        body: z.string().min(1),
      }),
      result: z.object({ comment: GithubComment }),
      timeoutMs: 60_000,
      description: '发一条评论',
    }),
    defineMethod({
      name: 'github.setDraft',
      owner: 'core',
      params: z.object({
        workspaceId: z.string().min(1),
        number: z.number().int().positive(),
        draft: z.boolean(),
      }),
      result: empty,
      timeoutMs: 60_000,
      description: '把 PR 转成草稿 / 标记为可评审（gh pr ready [--undo]）',
    }),
    defineMethod({
      name: 'github.mergePullRequest',
      owner: 'core',
      params: z.object({
        workspaceId: z.string().min(1),
        number: z.number().int().positive(),
        method: GithubMergeMethod,
      }),
      result: empty,
      timeoutMs: 60_000,
      description: '合并这个 PR（方法由调用方选：merge / squash / rebase）',
    }),

    defineMethod({
      name: 'review.turnChanges',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      result: TurnChanges,
      description: '这条线程每一轮改过哪些文件（turns 升序；行数是这一轮的真实增减，撤销后仍报原值）',
    }),
    defineMethod({
      name: 'review.previewTurnRewind',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), turn: z.number().int().positive() }),
      result: TurnRewindPreview,
      description: '撤销前的检查：按盘上当前内容与账本里的 after 比对，列出安全与不安全的文件；canApply = 没有不安全的',
    }),
    defineMethod({
      name: 'review.applyTurnRewind',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1), turn: z.number().int().positive() }),
      result: z.object({ turn: z.number().int().positive(), reverted: z.literal(true) }),
      description: '撤销这一轮的文件改动（只回退工作区，聊天历史不动）；有文件被外部改过时整轮拒绝 → rewind_unsafe',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'git.changed',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1) }),
      description: '仓库有变化（300ms 去抖后）',
    }),
    defineNotification({
      name: 'review.turnChangesChanged',
      owner: 'core',
      params: z.object({ threadId: z.string().min(1) }),
      description: '这一轮的文件账变了（落账或撤销之后）：界面重读 review.turnChanges',
    }),
  ],
  errors: reviewErrors,
})
