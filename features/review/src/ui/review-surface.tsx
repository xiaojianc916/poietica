import type { WorkspacesUi } from '@poietica/feature-workspaces/ui-api'
import { FileDiff } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { createReviewApi, createReviewGateway, openExternal } from './api'
import { CodeReviewPage } from './pr-page'
import { ReviewPane } from './review-pane'
import type { ReviewFailureReport } from './review-store'
import { useActiveWorkspaceId } from './surface'

/*
 * 审查功能里**重**的两块：右坞面板（diff 正文、卡与行带）与整页代码审查（PR 列表 / 详情 / 信息栏）。
 * `index.tsx` 用 dynamic import 取本模块，入口闭包只留 `surface.tsx` 里那两格轻的：
 * 状态栏的分支名与侧栏导航行。不要从这里反向 import `index.tsx`，也不要把轻的挪进来。
 */

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
        <FileDiff aria-hidden className=" opacity-30" />
        <p className="text-sm font-medium">还没有工作区</p>
        <p className="text-xs opacity-50">先添加一个工作区，这里会展示它的 git 改动。</p>
      </div>
    )
  }
  return <ReviewPane gateway={gateway} key={workspaceId} report={report} />
}

/*
 * 侧栏导航「代码审查」那一行落到的整页：左列表 / 中详情 / 右信息栏，数据是活动工作区远端仓库上的
 * pull request（读法在 review/core 的 gh 封装里）。页面本身不知道「哪个工作区」，跟面板那一路一样由
 * 组合根这一层固定。
 */
export function CodeReviewSurface({
  ctx,
  workspaces,
}: {
  readonly ctx: Parameters<typeof createReviewApi>[0]
  readonly workspaces: WorkspacesUi
}): ReactNode {
  return (
    <CodeReviewPage
      ctx={ctx}
      openExternal={(url) => {
        void openExternal(ctx, url).catch((cause: unknown) => {
          ctx.logger.warn('链接没能打开', { error: String(cause) })
        })
      }}
      workspaces={workspaces}
    />
  )
}
