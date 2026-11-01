import { describe, expect, test } from 'bun:test'
import { type WorkspaceGitFacts, workspaceGitContext } from '@poietica/feature-conversation/ui-api'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskPanelContent } from '../todo-panel'

/*
 * Git 那一格只在 worktree 真的增删了行时出现（ZCode 的 showGit 门）。干净仓库仍是一份在场的
 * 事实，但不该单独挂出「Git 工具」或整块状态面板。
 */

const facts = (added: number, removed: number): WorkspaceGitFacts => ({
  status: {
    added,
    ahead: 0,
    behind: 0,
    branch: 'main',
    branches: ['main'],
    busy: false,
    detachedAt: null,
    dirtyFileCount: 0,
    onRefresh: () => undefined,
    removed,
    upstream: null,
  },
})

function render(held: WorkspaceGitFacts | null): string {
  return renderToStaticMarkup(
    <workspaceGitContext.Provider value={held}>
      <TaskPanelContent backgroundTasks={[]} git={held?.status} gitPicker={held?.picker} todos={[]} />
    </workspaceGitContext.Provider>,
  )
}

describe('Git 工具那一格的渲染', () => {
  test('干净仓库不画 Git 工具，也不报 +0 -0', () => {
    const markup = render(facts(0, 0))

    expect(markup).not.toContain('Git 工具')
    expect(markup).not.toContain('+0')
    expect(markup).not.toContain('-0')
  })

  test('有增删时两个数照实报', () => {
    const markup = render(facts(12, 4))

    expect(markup).toContain('Git 工具')
    expect(markup).toContain('+12')
    expect(markup).toContain('-4')
  })

  test('没有事实（不是仓库 / 没读到）→ 整格不画', () => {
    expect(render(null)).not.toContain('Git 工具')
  })
})
