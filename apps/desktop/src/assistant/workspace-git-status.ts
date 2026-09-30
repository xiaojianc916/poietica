import type { GitBranchPickerProps, WorkspaceGitStatus } from '@poietica/conversation/surface'
import { type GitReview, reviewGateway } from '@poietica/native-bridge/review'
import { diffStatOf, parseUnifiedPatch } from '@poietica/review'
import { useEffect, useMemo, useState } from 'react'
import { useWorkspaceGit } from './workspace-git'

/** 宿主侧比面板多一样东西：分支下拉那一份 props（沿用既有 picker 的形状，不另造一套）。 */
export interface WorkspaceGitStatusView extends WorkspaceGitStatus {
  readonly picker: GitBranchPickerProps
}

/*
 * 状态面板 Git 区的事实源 = 既有分支面（useWorkspaceGit）+ 审查面的改动统计。
 *
 * 分支那一半不重写：检出、建分支、忙碌、失败上报都在 useWorkspaceGit 里，这里只是
 * 换个读法取值。新增的只有改动统计，且它复用审查包的正本 parseUnifiedPatch + diffStatOf，
 * 与审查面板读同一份数。
 *
 * 缺席（undefined）是本文件顶上那份契约的一半：不是 git 仓库、没装 git、还没读到，
 * 都交 undefined，由面板整格不画。干净仓库是**在场**的 —— 它只是没有增删。
 */
export function useWorkspaceGitStatus(root: string | null): WorkspaceGitStatusView | undefined {
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
    /*
     * 闸门在分支面：它不是 git 仓库时给 undefined，正是这里要的「这一区不画」。
     * 统计读不到只让那两个数字缺席，不让整格消失 —— 分支与「提交或推送」仍有事实。
     */
    if (root === null || picker === undefined) {
      return undefined
    }

    /*
     * 读到了仓库就是已知的 0（干净工作区照样报 +0 -0）；review 为 null 才是未知 ——
     * 还没读到或读失败，那种情况下不拿 0 冒充事实。
     */
    const stats =
      review === null
        ? null
        : (diffStatOf(parseUnifiedPatch(review.patch, false)) ?? { added: 0, removed: 0 })

    return {
      added: stats?.added ?? null,
      ahead: review?.ahead ?? 0,
      behind: review?.behind ?? 0,
      branch: picker.branch,
      branches: picker.branches,
      busy: picker.busy,
      detachedAt: picker.detachedAt,
      dirtyFileCount: review?.changes.length ?? 0,
      onRefresh: picker.onRefresh,
      picker,
      removed: stats?.removed ?? null,
      upstream: review?.upstream ?? null,
    }
  }, [picker, review, root])
}
