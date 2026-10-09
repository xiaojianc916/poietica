import { GitBranchPicker, useWorkspaceGitFacts } from '@poietica/feature-conversation/ui-api'
import type { ReactNode } from 'react'

/*
 * 输入框下方那一行的第二枚 chip：当前工作区检出的分支。
 *
 * **迁移自** legacy 的 `apps/desktop/src/assistant/workspace-git-status.ts`。新架构里这份
 * 数据属于 review，而它有两个落点（这一枚 chip 与状态面板的「Git 工具」那一格），
 * 所以由 review 贡献一个 Provider 把事实投到树上（conversation/ui-api 的 git-status.ts），
 * 两处读**同一个 store** —— 分支名、改动清单与 +N/-M 因此必然一致（legacy 是各读一份，
 * 产品负责人点出的老毛病）。
 *
 * 不是 git 仓库、还没读到、读失败：Context 是 null，这枚 chip 整个不存在；
 * HEAD 分离时分支名为 null、detachedAt 有值，label 随之变成「分离于 <短号>」。
 */
export function ComposerBranchChip(): ReactNode {
  const facts = useWorkspaceGitFacts()
  /* 分支名单读不到时退成只读的分支名（picker 缺席：不画切换入口）。 */
  if (facts === null) {
    return null
  }
  if (facts.picker === undefined) {
    return null
  }
  return <GitBranchPicker {...facts.picker} />
}
