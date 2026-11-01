import type { WorkspacesUi } from '@poietica/feature-workspaces/ui-api'
import {
  type NavigationService,
  NavigationToken,
  useFeatureStore,
  useNavigation,
  useService,
} from '@poietica/ui-kernel'
import { GitCompareArrows } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { createReviewApi } from './api'

/*
 * 审查功能在外壳里的两格**轻**落点：statusItems（left, order 20）当前分支名与侧栏导航行。
 * 面板与整页（diff 正文、PR 页签）在 `review-surface.tsx`，由 `index.tsx` 按需加载 ——
 * 本模块是入口闭包的一部分，不要在这里 import 它们。
 */

export function useActiveWorkspaceId(workspaces: WorkspacesUi): string | null {
  return useFeatureStore(workspaces.store, (held) => held.activeId)
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

/* 侧栏导航「代码审查」那一行。行的几何在 workbench 的全局样式（.sidebar-nav-row / __icon / __label），别在这里改；
 * 与「新建对话」「自动化」同一种行，选中态也由路由决定。 */
export function CodeReviewNavRow(): ReactNode {
  const { route } = useNavigation()
  const navigation = useService(NavigationToken) as NavigationService
  const active = route.surface === 'review.code'
  const className = [
    'sidebar-nav-row text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent',
    active ? 'bg-sidebar-accent text-foreground' : '',
  ]
    .filter((part) => part !== '')
    .join(' ')

  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={className}
      onClick={() => {
        navigation.navigate({ surface: 'review.code', params: {} })
      }}
      type="button"
    >
      <GitCompareArrows aria-hidden="true" className="sidebar-nav-row__icon" />
      <span className="sidebar-nav-row__label">代码审查</span>
    </button>
  )
}
