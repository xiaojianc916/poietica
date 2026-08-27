import { type GitFileChange, gitChanges, gitFilePatch } from '@poietica/ipc'
import { useCallback, useEffect, useState } from 'react'

import { reportFailure } from '../failures/application-policy'

/*
 * 工作目录此刻的变更面。
 *
 * 唯一真相是盘上的 git 工作树，所以这里不缓存：每问一次跑一次 git。答案带着它
 * 所属的 root 回来 —— 目录换了而旧请求刚落地时，那份答案不得写进新目录的界面。
 */

export type { GitFileChange }

export interface WorkspaceChanges {
  /** git 已经回答过了。回答之前不画空态：空态与「还没问到」不是一件事。 */
  readonly answered: boolean
  /** 不是 git 仓库、或机器没有 git，都是 null。 */
  readonly changes: readonly GitFileChange[] | null
  readonly refresh: () => void
  /** 每次回答换一个号：补丁据此重问，不必自己听 git。 */
  readonly revision: number
}

interface Answer {
  readonly root: string | null
  readonly changes: readonly GitFileChange[] | null
  readonly revision: number
}

export function useWorkspaceChanges(root: string | null): WorkspaceChanges {
  const [held, setHeld] = useState<Answer>({ changes: null, revision: 0, root: null })

  const ask = useCallback((target: string | null): void => {
    if (target === null) {
      setHeld({ changes: null, revision: 0, root: null })

      return
    }

    void gitChanges(target)
      .then((changes) => {
        setHeld((last) => ({ changes, revision: last.revision + 1, root: target }))
      })
      .catch((cause: unknown) => {
        reportFailure('GIT_CHANGES_UNREADABLE', { cause, scope: 'workspace-changes' })
        setHeld((last) => ({ changes: null, revision: last.revision + 1, root: target }))
      })
  }, [])

  useEffect(() => {
    ask(root)
  }, [ask, root])

  const refresh = useCallback(() => {
    ask(root)
  }, [ask, root])

  const answered = root !== null && held.root === root

  return {
    answered,
    changes: answered ? held.changes : null,
    refresh,
    revision: held.revision,
  }
}

/** 一个文件的补丁：问出去了 / 拿到了 / 读不到。 */
export type FilePatch =
  | { readonly state: 'asking' }
  | { readonly state: 'ready'; readonly patch: string }
  | { readonly state: 'refused' }

/** 一个文件此刻相对 HEAD 的补丁。清单换了（revision）补丁也旧了，重问。 */
export function useFilePatch(root: string | null, path: string, _revision: number): FilePatch {
  const [held, setHeld] = useState<FilePatch>({ state: 'asking' })

  useEffect(() => {
    if (root === null) {
      setHeld({ state: 'refused' })

      return undefined
    }

    let live = true
    setHeld({ state: 'asking' })

    void gitFilePatch(root, path)
      .then((patch) => {
        if (live) {
          setHeld({ state: 'ready', patch })
        }
      })
      .catch(() => {
        /* 一个文件的补丁读不到，不是这一格坏了：那一行自己说，清单照常。 */
        if (live) {
          setHeld({ state: 'refused' })
        }
      })

    return () => {
      live = false
    }
  }, [root, path])

  return held
}
