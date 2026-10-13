import { type GitBranchPickerProps, workspaceGitContext } from '@poietica/feature-conversation/ui-api'
import { type WorkspacesUi, WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { useFeatureStore, useService } from '@poietica/ui-kernel'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { createReviewApi, createReviewGateway, type ReviewApi } from './api'
import type { ReviewFailureReport } from './review-store'
import { useReviewStore } from './review-store-holder'
import { workspaceGitFactsOf } from './workspace-git-facts'

/* 状态面板「Git 工具」那一格的事实源。**与右侧「审查」面板同一份数据**：两者读 review-store-holder 里那个按工作区分片、按引用计数
 * 共享的 store，所以分支名、改动清单与 +N/-M 逐字相同。闸门在 reading.phase，只放 ready 过去；**干净仓库是在场的**，照样是
 * ready，交给面板的就是 +0 -0。 */

/* 没有工作区时这一格不存在，与「不是仓库」是同一个答案。 */
export function WorkspaceGitSource({
  children,
  ctx,
  report,
}: {
  readonly children: ReactNode
  readonly ctx: Parameters<typeof createReviewApi>[0]
  readonly report: ReviewFailureReport
}): ReactNode {
  const workspaces = useService(WorkspacesUiToken) as WorkspacesUi
  const workspaceId = useFeatureStore(workspaces.store, (held) => held.activeId)
  const api = useMemo(() => (workspaceId === null ? null : createReviewApi(ctx, workspaceId)), [ctx, workspaceId])

  if (api === null) {
    return <workspaceGitContext.Provider value={null}>{children}</workspaceGitContext.Provider>
  }
  return (
    <ActiveWorkspaceGit api={api} key={api.workspaceId} report={report}>
      {children}
    </ActiveWorkspaceGit>
  )
}

function ActiveWorkspaceGit({
  api,
  children,
  report,
}: {
  readonly api: ReviewApi
  readonly children: ReactNode
  readonly report: ReviewFailureReport
}): ReactNode {
  const gateway = useMemo(() => createReviewGateway(api), [api])
  const store = useReviewStore(gateway, report)
  const reading = useFeatureStore(store.store, (held) => held.reading)
  const [busy, setBusy] = useState(false)

  /* 动作成功之后重读一次 —— store.refresh() 走的是同一个 review()。 */
  const refresh = useCallback(() => {
    store.refresh()
  }, [store])

  const switchBranch = useCallback(
    async (branch: string): Promise<boolean> => {
      setBusy(true)
      try {
        await api.switchBranch(branch)
        refresh()
        return true
      } catch (cause: unknown) {
        report('GIT_REVIEW_ACTION_FAILED', { cause })
        return false
      } finally {
        setBusy(false)
      }
    },
    [api, refresh, report],
  )

  const createBranch = useCallback(
    async (branch: string): Promise<boolean> => {
      setBusy(true)
      try {
        await api.createBranch(branch, null)
        refresh()
        return true
      } catch (cause: unknown) {
        report('GIT_REVIEW_ACTION_FAILED', { cause })
        return false
      } finally {
        setBusy(false)
      }
    },
    [api, refresh, report],
  )

  const picker = useMemo<GitBranchPickerProps>(
    () => ({
      branch: reading.phase === 'ready' ? reading.head : null,
      branches: reading.phase === 'ready' ? reading.branches : [],
      busy,
      detachedAt: reading.phase === 'ready' ? reading.detachedAt : null,
      onCreate: createBranch,
      onRefresh: refresh,
      onSwitch: switchBranch,
    }),
    [busy, createBranch, reading, refresh, switchBranch],
  )

  const facts = useMemo(() => workspaceGitFactsOf(reading, picker), [picker, reading])
  return <workspaceGitContext.Provider value={facts}>{children}</workspaceGitContext.Provider>
}
