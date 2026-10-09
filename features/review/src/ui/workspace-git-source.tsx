import { type GitBranchPickerProps, workspaceGitContext } from '@poietica/feature-conversation/ui-api'
import { type WorkspacesUi, WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { useFeatureStore, useService } from '@poietica/ui-kernel'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { createReviewApi, createReviewGateway, type ReviewApi } from './api'
import type { ReviewFailureReport } from './review-store'
import { useReviewStore } from './review-store-holder'
import { workspaceGitFactsOf } from './workspace-git-facts'

/*
 * 状态面板「Git 工具」那一格的事实源（legacy 的 useWorkspaceGitStatus，逐条对应）。
 *
 * **与右侧「审查」面板同一份数据**：两者读 review-store-holder 里那一个按工作区分片、
 * 按引用计数共享的 store —— 不是两次读、两条刷新路径。所以分支名、改动清单与 +N/-M
 * 逐字相同，不会出现「审查面板说 +3 -1、浮层说 +0 -0」。legacy 是各建一份（宿主建一个
 * useWorkspaceGitStatus、面板自己再建一个），产品负责人 2026-10-07 点出的正是那个老毛病。
 *
 * 闸门在 reading.phase，只放 ready 过去：
 *   - notARepository → 不是 git 仓库 → 这一格整块不画（交 null）；
 *   - asking / unreadable → 还没读到或读失败 → 同样不画（分支名与改动数都还没有事实，
 *     画出来就是个假象）。legacy 在这一档仍然画壳、只把两个数字撤掉，而那正是「一块
 *     空标题躺在屏幕上」的来源。
 * **干净仓库是在场的**：它只是没有增删，照样是 ready，交给面板的就是 +0 -0。
 */

/* 有工作区才谈得上 git：没有工作区时这一格不存在，与「不是仓库」是同一个答案。 */
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
  /* key：换工作区整格重挂，分支忙碌与弹层开合这些界面状态不会跨仓库残留。 */
  return (
    <ActiveWorkspaceGit api={api} key={api.workspaceId} report={report}>
      {children}
    </ActiveWorkspaceGit>
  )
}

/* 有活动工作区的那一支：它才建 store、才订阅 git。 */
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

  /*
   * 刷新与切换：动作成功之后重读一次 —— store.refresh() 走的是同一个 review()，
   * 所以浮层与审查面板下一帧拿到的是同一份新数。
   */
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
        /* 失败由审查面统一上报（守则 5/7：错误码与呈现都不在这一层）。 */
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
