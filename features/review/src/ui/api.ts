import type { UiFeatureContext } from '@poietica/ui-kernel'
import { type GitBranch, type GitStatus, type ReviewFile, reviewContract } from '../contract'

/**
 * `ctx.rpc(reviewContract)` 的薄封装。
 *
 * 契约以 workspaceId 为键（07 页 §10B），而 legacy 的审查面用的是仓库根路径；
 * 把「哪个工作区」这件事固定在组合根这一层，审查面因此不认识工作区。
 */
export function createReviewApi(ctx: UiFeatureContext, workspaceId: string) {
  const rpc = ctx.rpc(reviewContract)

  return {
    workspaceId,
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
    onChanged: (listener: () => void) =>
      rpc.on('git.changed', (p: { workspaceId: string }) => {
        if (p.workspaceId === workspaceId) listener()
      }),
  }
}

export type ReviewApi = ReturnType<typeof createReviewApi>

/**
 * 把契约的薄封装折成审查面要的那份 `ReviewGateway`（07 页 §10E）。
 *
 * 三个动作面的差别只有一件事：契约按 workspaceId 寻址、审查面按仓库根寻址，
 * 而上面这个闭包已经把 workspaceId 固定住了。除此之外逐字接过去：
 *   review      → git.status + git.review + git.branches（一次问齐，同 legacy 的「一次快照」）
 *   filePatch   → git.filePatch
 *   watch       → git.watch / git.unwatch + git.changed（契约自己是引用计数的）
 *   commit      → git.commit（intent 由 store 决定；契约只有提交一条路，推送不在此列）
 */
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
      await api.watch()
      const off = api.onChanged(onChange)
      return async () => {
        off.dispose()
        await api.unwatch()
      }
    },
    commit: (request) => api.commit(request.message, request.stageAll),
  }
}
