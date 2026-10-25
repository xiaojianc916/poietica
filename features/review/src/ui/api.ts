import { platformContract } from '@poietica/feature-platform/contract'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import {
  type GitBranch,
  type GithubAvailability,
  type GithubComment,
  type GithubMergeMethod,
  type GithubPullRequest,
  type GithubPullSummary,
  type GithubRepository,
  type GitStatus,
  type ReviewFile,
  reviewContract,
} from '../contract'
import { coreSessionOf } from './core-session'
import type { TurnChangesGateway } from './turn-changes-source'

/** `ctx.rpc(reviewContract)` 的薄封装。契约以 workspaceId 为键而审查面按仓库根寻址，所以「哪个工作区」固定在组合根这一层。 */
export function createReviewApi(ctx: UiFeatureContext, workspaceId: string) {
  const rpc = ctx.rpc(reviewContract)

  return {
    workspaceId,
    session: coreSessionOf(ctx),
    status: (): Promise<GitStatus> => rpc.call('git.status', { workspaceId }),
    branches: (): Promise<{ current: string | null; branches: GitBranch[] }> =>
      rpc.call('git.branches', { workspaceId }),
    switchBranch: (branch: string): Promise<GitStatus> => rpc.call('git.switchBranch', { workspaceId, branch }),
    createBranch: (branch: string, from: string | null): Promise<GitStatus> =>
      rpc.call('git.createBranch', { workspaceId, branch, from }),
    review: (base: 'HEAD' | 'index'): Promise<readonly ReviewFile[]> =>
      rpc.call('git.review', { workspaceId, base }).then((r) => r.files),
    filePatch: (path: string, base: 'HEAD' | 'index'): Promise<string> =>
      rpc.call('git.filePatch', { workspaceId, path, base }).then((r) => r.patch),
    stage: (paths: readonly string[]): Promise<GitStatus> => rpc.call('git.stage', { workspaceId, paths: [...paths] }),
    unstage: (paths: readonly string[]): Promise<GitStatus> =>
      rpc.call('git.unstage', { workspaceId, paths: [...paths] }),
    commit: (message: string, stageAll: boolean): Promise<{ commit: string }> =>
      rpc.call('git.commit', { workspaceId, message, stageAll }),
    watch: (): Promise<Record<string, never>> => rpc.call('git.watch', { workspaceId }),
    unwatch: (): Promise<Record<string, never>> => rpc.call('git.unwatch', { workspaceId }),
    githubAvailability: (): Promise<GithubAvailability> => rpc.call('github.availability', {}),
    githubRepository: (): Promise<GithubRepository | null> =>
      rpc.call('github.repository', { workspaceId }).then((r) => r.repository),
    githubPullRequests: (): Promise<{ repository: GithubRepository | null; pulls: readonly GithubPullSummary[] }> =>
      rpc.call('github.pullRequests', { workspaceId, includeClosed: true }),
    githubPullRequest: (number: number): Promise<GithubPullRequest> =>
      rpc.call('github.pullRequest', { workspaceId, number }).then((r) => r.pull),
    githubComments: (number: number): Promise<readonly GithubComment[]> =>
      rpc.call('github.comments', { workspaceId, number }).then((r) => r.comments),
    githubComment: (number: number, body: string): Promise<GithubComment> =>
      rpc.call('github.comment', { workspaceId, number, body }).then((r) => r.comment),
    githubSetDraft: (number: number, draft: boolean): Promise<void> =>
      rpc.call('github.setDraft', { workspaceId, number, draft }).then(() => undefined),
    githubMerge: (number: number, method: GithubMergeMethod): Promise<void> =>
      rpc.call('github.mergePullRequest', { workspaceId, number, method }).then(() => undefined),
    onChanged: (listener: () => void) =>
      rpc.on('git.changed', (p: { workspaceId: string }) => {
        if (p.workspaceId === workspaceId) listener()
      }),
  }
}

/**
 * 每轮回复下方那条改动条的薄封装（`review.turnChanges` 一族）。**按对话寻址**，与上面那个闭包
 * 按工作区寻址不同 —— 账记在对话上，撤销时才由 core 按对话查出所属工作区。
 *
 * 方法名只出现在这里：组件与 Provider 都不拼 RPC 名字。
 */
export function createTurnChangesApi(ctx: UiFeatureContext): TurnChangesGateway {
  const rpc = ctx.rpc(reviewContract)

  return {
    list: async (threadId) => (await rpc.call('review.turnChanges', { threadId })).turns,
    preview: (threadId, turn) => rpc.call('review.previewTurnRewind', { threadId, turn }),
    apply: async (threadId, turn) => {
      await rpc.call('review.applyTurnRewind', { threadId, turn })
    },
    onChanged: (listener) =>
      rpc.on('review.turnChangesChanged', (p) => {
        listener(p.threadId)
      }),
  }
}

export type ReviewApi = ReturnType<typeof createReviewApi>

export function openExternal(ctx: UiFeatureContext, url: string): Promise<Record<string, never>> {
  return ctx.rpc(platformContract).call('shell.openExternal', { url })
}

/** 折成审查面要的那份 `ReviewGateway`。契约按 workspaceId 寻址、审查面按仓库根，而上面那个闭包已把 workspaceId 固定住。 */
export function createReviewGateway(api: ReviewApi): import('./review-store').ReviewGateway {
  return {
    workspaceId: api.workspaceId,
    async review(_base, _ignoreWhitespace) {
      const status = await api.status()
      if (!status.isRepo) {
        return null
      }
      const [changes, branches] = await Promise.all([api.review('HEAD'), api.branches()])
      return {
        status,
        changes,
        staged: status.staged.map((entry) => entry.path),
        branches: branches.branches.map((branch) => branch.name),
      }
    },
    filePatch: (_base, path, _ignoreWhitespace) => api.filePatch(path, 'HEAD'),
    async watch(onChange) {
      const born = api.session.generation()
      await api.watch()
      const off = api.onChanged(onChange)
      /*
       * Core 换了一世：新进程里没有这一份计数，重发一次，并照样重读一次（断线期间的改动没有通知）。重发失败也重读 ——
       * 读得到就是最新，读不到由那一次读去报错。注册之后才丢的 Core 才要重发：断线期间注册的那一次本来就发给了新的一世。
       */
      let sent = born
      const offRenewed = api.session.onRenewed(() => {
        const now = api.session.generation()
        if (sent === now) return
        sent = now
        api.watch().then(onChange, onChange)
      })
      return async () => {
        off.dispose()
        offRenewed()
        await api.unwatch()
      }
    },
    commit: (request) => api.commit(request.message, request.stageAll),
  }
}
/** 代码审查页那一份：契约里 github.* 的薄封装。 */
export function createGithubGateway(api: ReviewApi): import('./pr-store').PrGateway {
  return {
    availability: () => api.githubAvailability(),
    pullRequests: () => api.githubPullRequests(),
    pullRequest: (number) => api.githubPullRequest(number),
    comments: (number) => api.githubComments(number),
    comment: (number, body) => api.githubComment(number, body),
    setDraft: (number, draft) => api.githubSetDraft(number, draft),
    merge: (number, method) => api.githubMerge(number, method),
  }
}
