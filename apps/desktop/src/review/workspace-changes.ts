import { type GitFileChange, gitAwaitChange, gitChanges, gitFilePatch } from '@poietica/ipc'
import { useEffect, useState } from 'react'

import { reportFailure } from '../failures/application-policy'

/*
 * 工作目录此刻的变更面。
 *
 * 唯一真相是盘上的 git 工作树，所以这里不缓存：每问一次跑一次 git。谁来叫这一次
 * 问也只有一条路 —— 原生侧的文件系统监视说这个目录动了（gitAwaitChange）。一问
 * 一等接成一个循环，目录换了就整条换掉，旧目录的答案不可能落进新目录的界面。
 */

export type { GitFileChange }

/** 这一格此刻的处境。四种答案互不重叠 —— 空态与「还没问到」不是一件事。 */
export type WorkspaceChanges =
  | { readonly state: 'asking' }
  | {
      readonly state: 'listed'
      readonly changes: readonly GitFileChange[]
      /** 每次回答换一个号：展开着的补丁据此重问。 */
      readonly generation: number
    }
  | { readonly state: 'notARepository' }
  | { readonly state: 'unreadable' }

export function useWorkspaceChanges(root: string | null): WorkspaceChanges {
  const [held, setHeld] = useState<WorkspaceChanges>({ state: 'asking' })

  useEffect(() => {
    setHeld({ state: 'asking' })

    if (root === null) {
      return undefined
    }

    let live = true
    let generation = 0

    const follow = async (): Promise<void> => {
      while (live) {
        try {
          const changes = await gitChanges(root)

          if (!live) {
            return
          }

          generation += 1
          setHeld(
            changes === null
              ? { state: 'notARepository' }
              : { changes, generation, state: 'listed' },
          )
        } catch (cause: unknown) {
          if (!live) {
            return
          }

          reportFailure('GIT_CHANGES_UNREADABLE', { cause, scope: 'workspace-changes' })
          setHeld({ state: 'unreadable' })
        }

        try {
          await gitAwaitChange(root)
        } catch (cause: unknown) {
          /* 挂不上表就没有下一次问：说一次，然后停 —— 不退化成静默的轮询。 */
          if (live) {
            reportFailure('GIT_CHANGES_UNREADABLE', { cause, scope: 'workspace-changes' })
          }

          return
        }
      }
    }

    void follow()

    return () => {
      live = false
    }
  }, [root])

  return held
}

/** 一个文件的补丁：问出去了 / 拿到了 / 读不到。 */
export type FilePatch =
  | { readonly state: 'asking' }
  | { readonly state: 'ready'; readonly patch: string }
  | { readonly state: 'refused' }

/** 一个文件此刻相对 HEAD 的补丁。清单换了号，这一份也旧了，重问。 */
export function useFilePatch(root: string, path: string, _generation: number): FilePatch {
  const [held, setHeld] = useState<FilePatch>({ state: 'asking' })

  useEffect(() => {
    let live = true
    setHeld({ state: 'asking' })

    void gitFilePatch(root, path).then(
      (patch) => {
        if (live) {
          setHeld({ patch, state: 'ready' })
        }
      },
      () => {
        /* 一个文件读不到，不是这一格坏了：那一行自己说，清单照常。 */
        if (live) {
          setHeld({ state: 'refused' })
        }
      },
    )

    return () => {
      live = false
    }
  }, [path, root])

  return held
}
