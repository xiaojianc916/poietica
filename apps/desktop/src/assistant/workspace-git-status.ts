import type { GitBranchPickerProps, WorkspaceGitStatus } from '@poietica/conversation/surface'
import { type GitReview, reviewGateway } from '@poietica/native-bridge/review'
import { diffStatOf, parseUnifiedPatch } from '@poietica/review'
import { useEffect, useMemo, useState } from 'react'
import { useWorkspaceGit } from './workspace-git'

/** 宿主侧比面板多一样东西：分支下拉那一份 props（沿用既有 picker 的形状，不另造一套）。 */
export interface WorkspaceGitStatusView extends WorkspaceGitStatus {
  readonly picker: GitBranchPickerProps | undefined
}

/*
 * 状态面板 Git 区的事实源 = 既有分支面（useWorkspaceGit）+ 审查面的改动统计。
 *
 * 分支那一半不重写：检出、建分支、忙碌、失败上报都在 useWorkspaceGit 里，这里只是
 * 换个读法取值。新增的只有改动统计，且它复用审查包的正本 parseUnifiedPatch + diffStatOf，
 * 与审查面板读同一份数。
 */
export function useWorkspaceGitStatus(root: string | null): WorkspaceGitStatusView {
  const picker = useWorkspaceGit(root)
  const [review, setReview] = useState<GitReview | null>(null)

  const refresh = picker?.onRefresh

  useEffect(() => {
    if (root === null) {
      setReview(null)

      return
    }

    let held = true
    const read = () => {
      void reviewGateway.review(root, 'HEAD', 0, false).then(
        (next) => {
          if (held) {
            setReview(next)
          }
        },
        () => {
          if (held) {
            setReview(null)
          }
        },
      )
    }

    setReview(null)
    read()

    return () => {
      held = false
    }
  }, [refresh, root])

  return useMemo(() => {
    const stats = review === null ? null : diffStatOf(parseUnifiedPatch(review.patch, false))

    return {
      added: stats?.added ?? null,
      ahead: review?.ahead ?? 0,
      behind: review?.behind ?? 0,
      branch: picker?.branch ?? review?.branch ?? null,
      branches: picker?.branches ?? review?.branches ?? [],
      busy: picker?.busy ?? false,
      detachedAt: picker?.detachedAt ?? review?.detachedAt ?? null,
      dirtyFileCount: review?.changes.length ?? 0,
      onRefresh: picker?.onRefresh ?? (() => undefined),
      picker,
      removed: stats?.removed ?? null,
      upstream: review?.upstream ?? null,
    }
  }, [picker, review])
}
