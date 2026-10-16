import type { GitBranchPickerProps } from '@poietica/design-system'
import type { WorkspaceGitFacts } from '@poietica/feature-conversation/ui-api'
import type { ReviewReading } from './review-store'

/* 审查 store 的一份读数 → 状态面板那一格要的事实。纯函数，判据是**这一个函数**说了算：只有 ready 才有事实，notARepository 与
 * asking/unreadable 一律交回 null —— 没有事实时画一个空壳，屏幕上就是一块空标题；**干净仓库是在场的**，它是 ready 只是两个数
 * 都是 0，照样交事实（+0 -0）。 */
export function workspaceGitFactsOf(reading: ReviewReading, picker: GitBranchPickerProps): WorkspaceGitFacts | null {
  if (reading.phase !== 'ready') {
    return null
  }
  return {
    picker,
    status: {
      added: reading.stat.added,
      ahead: reading.ahead,
      behind: reading.behind,
      branch: reading.head,
      branches: reading.branches,
      busy: picker.busy,
      detachedAt: reading.detachedAt,
      dirtyFileCount: reading.files.length,
      onRefresh: picker.onRefresh,
      removed: reading.stat.removed,
      upstream: reading.upstream,
    },
  }
}
