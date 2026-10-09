import { describe, expect, test } from 'bun:test'
import { type WorkspaceGitFacts, workspaceGitContext } from '@poietica/feature-conversation/ui-api'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskPanelContent } from './todo-panel'

/*
 * 「Git 工具」那一格在屏幕上的样子（产品负责人 2026-10-07 的要求）：
 * **git 没有增减也要显示这一格，显示 +0 -0 就可以**。
 *
 * 判据（什么时候算「有事实」）在 review 的 workspaceGitFactsOf，那边有单测；这里看的是
 * 面板这一层：有事实就画得出标题与两个数，没事实就整格不画。
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
  test('干净仓库照画：标题 + 更改行 + 加 0 减 0', () => {
    const markup = render(facts(0, 0))

    expect(markup).toContain('Git 工具')
    expect(markup).toContain('更改')
    expect(markup).toContain('+0')
    expect(markup).toContain('-0')
  })

  test('有增删时两个数照实报', () => {
    const markup = render(facts(12, 4))

    expect(markup).toContain('+12')
    expect(markup).toContain('-4')
  })

  test('没有事实（不是仓库 / 没读到）→ 整格不画', () => {
    expect(render(null)).not.toContain('Git 工具')
  })
})
