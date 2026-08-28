import { throughIpc } from './error'
import {
  commands,
  type GitBranches,
  type GitCommitIntent,
  type GitCommitRequest,
  type GitFileChange,
  type GitReview,
} from './generated/ipc-bindings'

/*
 * 工作目录的 git 分支面。
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

/** 问一次审查面：分支、上游、清单与整份补丁。不是 git 仓库就是 null。 */
export function gitReview(
  root: string,
  base: string,
  context: number,
  ignoreWhitespace: boolean,
): Promise<GitReview | null> {
  return throughIpc(() => commands.gitReview(root, base, context, ignoreWhitespace))
}

/** 问一个文件的整份补丁：折叠带上的行由它带回来。 */
export function gitFilePatch(
  root: string,
  base: string,
  path: string,
  ignoreWhitespace: boolean,
): Promise<string> {
  return throughIpc(() => commands.gitFilePatch(root, base, path, ignoreWhitespace))
}

/** 挂上原生监视，等这个目录的下一次变化。false = 这一窗里没动，再挂一次。 */
export function gitAwaitChange(root: string): Promise<boolean> {
  return throughIpc(() => commands.gitAwaitChange(root))
}

/** 提交或推送，交回新的审查面。git 拒绝时抛出，理由原文透出。 */
export function gitCommit(request: GitCommitRequest): Promise<GitReview> {
  return throughIpc(() => commands.gitCommit(request))
}

/** 创建并检出新分支，交回新快照。名字合法性由 git 判，拒绝理由原文透出。 */
export function gitCreateBranch(root: string, branch: string): Promise<GitBranches> {
  return throughIpc(() => commands.gitCreateBranch(root, branch))
}
