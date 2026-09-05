import {
  commands,
  events,
  type GitBranches,
  type GitCommitIntent,
  type GitCommitRequest,
  type GitFileChange,
  type GitReview,
} from '@poietica/contract'
import type { ReviewGateway } from '@poietica/review'
import { throughIpc } from '../error'

/*
 * 工作目录的 git 分支面与审查面。
 *
 * 分支的唯一真相是磁盘上的仓库；这一层不缓存也不判定，只把 git 的回答运过来。
 * 切换与创建直接交回新快照 —— 界面不用自己拼「操作后的世界」，一次往返就拿到
 * 磁盘上的新真相。
 */

export type { GitBranches, GitCommitIntent, GitCommitRequest, GitFileChange, GitReview }

/** 问一个目录的分支快照。不是 git 仓库、或机器没有 git，都是 null。 */
export function gitBranches(root: string): Promise<GitBranches | null> {
  return throughIpc(() => commands.gitBranches(root))
}

/** 检出一个已有分支，交回新快照。git 拒绝时抛出，理由原文透出。 */
export function gitSwitchBranch(root: string, branch: string): Promise<GitBranches> {
  return throughIpc(() => commands.gitSwitchBranch(root, branch))
}

/** 创建并检出新分支，交回新快照。名字合法性由 git 判，拒绝理由原文透出。 */
export function gitCreateBranch(root: string, branch: string): Promise<GitBranches> {
  return throughIpc(() => commands.gitCreateBranch(root, branch))
}

/*
 * 审查会话的 IPC 实现：实现 @poietica/review 的 ReviewGateway 端口，由组合根
 * 注入 review-store。
 */
export const reviewGateway: ReviewGateway = {
  /* 问一次审查面：分支、上游、清单与整份补丁。不是 git 仓库就是 null。 */
  review: (root, base, context, ignoreWhitespace) =>
    throughIpc(() => commands.gitReview(root, base, context, ignoreWhitespace)),

  /* 问一个文件的整份补丁：折叠带上的行由它带回来。 */
  filePatch: (root, base, path, ignoreWhitespace) =>
    throughIpc(() => commands.gitFilePatch(root, base, path, ignoreWhitespace)),

  async watch(root, onChange) {
    let canonical: string | null = null
    let pending = false
    const unlisten = await events.gitWorkingTreeChanged.listen((event) => {
      if (canonical === null) {
        pending = true
      } else if (event.payload.root === canonical) {
        onChange()
      }
    })
    try {
      const lease = await throughIpc(() => commands.gitWatchStart(root))
      canonical = lease.root
      if (pending) {
        onChange()
      }
      return async () => {
        unlisten()
        await throughIpc(() => commands.gitWatchStop(lease.token))
      }
    } catch (cause) {
      unlisten()
      throw cause
    }
  },

  /* 提交或推送，交回新的审查面。git 拒绝时抛出，理由原文透出。 */
  commit: (request) => throughIpc(() => commands.gitCommit(request)),
}
