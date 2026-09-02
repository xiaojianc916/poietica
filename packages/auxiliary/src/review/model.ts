/* Domain-owned vocabulary. The native bridge translates generated wire DTOs at the process boundary. */
export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'untracked' | 'conflicted'
export type GitCommitIntent = 'commit' | 'commit-and-push' | 'push'
export type GitCommitRequest = {
  root: string
  intent: GitCommitIntent
  message: string
  stageAll: boolean
  base: string
  context: number
  ignoreWhitespace: boolean
}
export type GitFileChange = { path: string; status: GitChangeStatus; staged: boolean }
export type GitReview = {
  branch: string | null
  detachedAt: string | null
  upstream: string | null
  ahead: number
  behind: number
  branches: string[]
  changes: GitFileChange[]
  patch: string
}
