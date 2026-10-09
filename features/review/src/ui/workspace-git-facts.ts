import type { GitBranchPickerProps, WorkspaceGitFacts } from '@poietica/feature-conversation/ui-api'
import type { ReviewReading } from './review-store'

/*
 * 审查 store 的一份读数 → 状态面板那一格要的事实。
 *
 * 单独一个纯函数（不碰 React、不碰 store）：判据是**这一个函数**说了算，可以直接单测。
 * 三条规则：
 *   - 只有 ready 才有事实。notARepository（不是仓库）与 asking/unreadable（还没读到、读失败）
 *     一律交回 null —— 面板据此整格不画。没有事实时画一个空壳，屏幕上就是一块空标题。
 *   - **干净仓库是在场的**：它是 ready，只是两个数都是 0，照样交事实（+0 -0）。
 *   - 分支名单与改动数同出一份读数，所以不会出现「分支切了、数字还是上一个分支的」。
 */
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
