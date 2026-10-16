import { GitBranchPicker } from '@poietica/design-system'
import { useWorkspaceGitFacts } from '@poietica/feature-conversation/ui-api'
import type { ReactNode } from 'react'

/* 输入框下方那一行的第二枚 chip：当前工作区分支。这份数据属于 review 而有两个落点（这枚 chip 与状态面板的「Git 工具」），所以
 * 由 review 贡献一个 Provider 把事实投到树上，两处读**同一个 store** —— 分支名、改动清单与 +N/-M 因此必然一致。不是 git 仓库、
 * 还没读到、读失败时 Context 是 null，这枚 chip 整个不存在；HEAD 分离时分支名为 null、label 变成「分离于 <短号>」。 */
export function ComposerBranchChip(): ReactNode {
  const facts = useWorkspaceGitFacts()
  if (facts === null) {
    return null
  }
  if (facts.picker === undefined) {
    return null
  }
  return <GitBranchPicker {...facts.picker} />
}
