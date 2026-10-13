import { type WorkspacesUi, WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { useFeatureStore } from '@poietica/ui-kernel'
import { FileDiff } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { createReviewApi, createReviewGateway } from './api'
import { ReviewPane } from './review-pane'
import type { ReviewFailureReport } from './review-store'

/* 审查功能在外壳里的落点：panels（right, order 10）「审查」；statusItems（left, order 20）当前分支名。两处都要「哪个工作区」这件事，
 * 而它属于 workspaces —— 所以 createReviewApi 把 workspaceId 固定在组合根这一层。 */

function useActiveWorkspaceId(workspaces: WorkspacesUi): string | null {
  return useFeatureStore(workspaces.store, (held) => held.activeId)
}

export function ReviewPanel({
  report,
  workspaces,
  ctx,
}: {
  readonly ctx: Parameters<typeof createReviewApi>[0]
  readonly report: ReviewFailureReport
  readonly workspaces: WorkspacesUi
}): ReactNode {
  const workspaceId = useActiveWorkspaceId(workspaces)
  const gateway = useMemo(
    () => (workspaceId === null ? null : createReviewGateway(createReviewApi(ctx, workspaceId))),
    [ctx, workspaceId],
  )
  if (gateway === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileDiff aria-hidden className="size-8 opacity-30" />
        <p className="text-sm font-medium">还没有工作区</p>
        <p className="text-xs opacity-50">先添加一个工作区，这里会展示它的 git 改动。</p>
      </div>
    )
  }
  return <ReviewPane gateway={gateway} key={workspaceId} report={report} />
}

/* 状态栏左端那一格：当前分支名。状态栏按产品决定删掉了（refactor-log 偏差 #7），这个贡献点因此暂时没有消费者；仍注册 ——
 * 它是「当前分支」的正式住处，将来谁要显示分支读它，而不是各自再问一遍 git。 */
export function BranchStatusItem({
  ctx,
  workspaces,
}: {
  readonly ctx: Parameters<typeof createReviewApi>[0]
  readonly workspaces: WorkspacesUi
}): ReactNode {
  const workspaceId = useActiveWorkspaceId(workspaces)
  const api = useMemo(() => (workspaceId === null ? null : createReviewApi(ctx, workspaceId)), [ctx, workspaceId])
  const [branch, setBranch] = useState<string | null>(null)
  useEffect(() => {
    if (api === null) {
      setBranch(null)
      return
    }
    let live = true
    const read = (): void => {
      void api.status().then(
        (status) => {
          if (live) setBranch(status.isRepo ? status.branch : null)
        },
        () => {
          if (live) setBranch(null)
        },
      )
    }
    const off = api.onChanged(read)
    read()
    return () => {
      live = false
      off.dispose()
    }
  }, [api])
  if (branch === null) {
    return null
  }
  return <span className="truncate text-xs text-muted-foreground">{branch}</span>
}

export function useWorkspacesUi(ctx: { services: { get<T>(token: unknown): T } }): WorkspacesUi {
  return ctx.services.get<WorkspacesUi>(WorkspacesUiToken)
}
