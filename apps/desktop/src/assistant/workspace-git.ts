import type { GitBranchPickerProps } from '@poietica/conversation/surface'
import {
  type GitBranches,
  gitBranches,
  gitCreateBranch,
  gitSwitchBranch,
} from '@poietica/native-bridge/review'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { reportFailure } from '../notice/problem-presentation'

interface GitView {
  readonly root: string
  readonly snapshot: GitBranches | null
  readonly busy: boolean
}

export function useWorkspaceGit(root: string | null): GitBranchPickerProps | undefined {
  const [view, setView] = useState<GitView | null>(null)
  const activeRootRef = useRef(root)

  activeRootRef.current = root

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
