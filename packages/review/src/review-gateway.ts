import type { GitCommitIntent, GitCommitRequest, GitReview } from '@poietica/contract/review'

export interface ReviewGateway {
  /** 一次快照问法：清单、分支与带上下文的补丁一次读齐。 */
  review(
    root: string,
    base: string,
    context: number,
    ignoreWhitespace: boolean,
  ): Promise<GitReview | null>
  /** 某一份文件的全文补丁（开着的文件才取，带词级差异所需的全行）。 */
  filePatch(root: string, base: string, path: string, ignoreWhitespace: boolean): Promise<string>
  /** Acquire one native shared watcher lease. Releasing it cancels observation immediately. */
  watch(root: string, onChange: () => void): Promise<() => Promise<void>>
  /** 提交或推送。回给提交之后的下一份快照。 */
  commit(request: GitCommitRequest): Promise<GitReview>
}

/** 审查侧会用到的两种失败；上报的形状由组合根决定。 */
export type ReviewFailureCode = 'GIT_CHANGES_UNREADABLE' | 'GIT_REVIEW_ACTION_FAILED'

export type ReviewFailureReport = (
  code: ReviewFailureCode,
  context: { readonly cause: unknown },
) => void

export type { GitCommitIntent }
