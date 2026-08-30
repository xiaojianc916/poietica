import type { GitBranchPickerProps } from '@poietica/agent-ui'
import {
  type GitBranches,
  gitBranches,
  gitCreateBranch,
  gitSwitchBranch,
} from '@poietica/native-bridge'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { reportFailure } from './failures/application-policy'

/*
 * 当前工作目录的 git 分支快照，交给输入框下方那枚分支 chip。
 *
 * 唯一真相在磁盘上的仓库里；这里只持有「对 activeRoot 的最后一次回答」这一份
 * 快照，别无副本。三条写路径（换目录重问、弹层打开重问、切换/创建拿回的新
 * 快照）都汇到同一个 commit，并且都带着自己所属的 root —— 目录已经换走的
 * 回答一律丢弃，不许旧目录的分支挂在新目录的 chip 上。
 *
 * 不是仓库、机器没有 git、或者还没回答，都返回 undefined：chip 整个不渲染。
 */

interface GitView {
  readonly root: string
  readonly snapshot: GitBranches | null
  readonly busy: boolean
}

export function useWorkspaceGit(root: string | null): GitBranchPickerProps | undefined {
  const [view, setView] = useState<GitView | null>(null)
  const activeRootRef = useRef(root)

  activeRootRef.current = root

  /* 只认属于当前 root 的更新；函数式 set 让并发回答按到达顺序收敛。 */
  const commit = useCallback((forRoot: string, change: (held: GitView) => GitView) => {
    setView((held) => (held !== null && held.root === forRoot ? change(held) : held))
  }, [])

  const refresh = useCallback(
    (forRoot: string) => {
      void gitBranches(forRoot).then(
        (snapshot) => {
          commit(forRoot, (held) => ({ ...held, snapshot }))
        },
        () => {
          /* 问不出快照就当没有仓库：chip 消失，而不是挂一枚指错路的 chip。 */
          commit(forRoot, (held) => ({ ...held, snapshot: null }))
        },
      )
    },
    [commit],
  )

  useEffect(() => {
    if (root === null) {
      setView(null)

      return
    }

    setView({ busy: false, root, snapshot: null })
    refresh(root)
  }, [refresh, root])

  /*
   * 切换与创建共用一条提交路径：成功拿回盘面快照；失败进入应用唯一的通知与
   * 诊断管线。目录已切走的异步失败不再污染当前工作区。
   */
  const apply = useCallback(
    async (
      forRoot: string,
      operationName: 'create-branch' | 'switch-branch',
      operation: Promise<GitBranches>,
    ): Promise<boolean> => {
      commit(forRoot, (held) => ({ ...held, busy: true }))

      try {
        const snapshot = await operation

        commit(forRoot, (held) => ({ ...held, busy: false, snapshot }))

        return activeRootRef.current === forRoot
      } catch (cause: unknown) {
        commit(forRoot, (held) => ({ ...held, busy: false }))

        if (activeRootRef.current === forRoot) {
          reportFailure('GIT_BRANCH_OPERATION_FAILED', {
            cause,
            operation: operationName,
            scope: 'workspace-git',
          })
        }

        return false
      }
    },
    [commit],
  )

  return useMemo(() => {
    if (root === null || view === null || view.root !== root || view.snapshot === null) {
      return undefined
    }

    const snapshot = view.snapshot

    return {
      branch: snapshot.branch,
      branches: snapshot.branches,
      busy: view.busy,
      detachedAt: snapshot.detachedAt,
      onCreate: (branch: string) => apply(root, 'create-branch', gitCreateBranch(root, branch)),
      onRefresh: () => {
        refresh(root)
      },
      onSwitch: (branch: string) => apply(root, 'switch-branch', gitSwitchBranch(root, branch)),
    }
  }, [apply, refresh, root, view])
}
