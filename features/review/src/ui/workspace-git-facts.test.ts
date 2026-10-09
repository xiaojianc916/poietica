import { describe, expect, test } from 'bun:test'
import type { GitBranchPickerProps } from '@poietica/feature-conversation/ui-api'
import type { ReviewReading } from './review-store'
import { workspaceGitFactsOf } from './workspace-git-facts'

/*
 * 状态面板「Git 工具」那一格的判据（产品负责人 2026-10-07 的要求）：
 * **只要是 git 工作区就恒画，没有增删也画 +0 -0**。
 *
 * 这一组钉的正是那条：
 *   - 干净仓库（0/0）必须交回事实 —— 交 null 就等于「这一格不画」，那是缺陷本身；
 *   - 没有事实的三档（不是仓库 / 还没读到 / 读失败）交 null，不拿 0 冒充事实；
 *   - 分支名与改动数同出一份读数（切了分支就一起换，不会一新一旧）。
 */

const picker: GitBranchPickerProps = {
  branch: null,
  branches: [],
  busy: false,
  detachedAt: null,
  onCreate: async () => true,
  onRefresh: () => undefined,
  onSwitch: async () => true,
}

type Ready = Extract<ReviewReading, { phase: 'ready' }>

function ready(over: Partial<Ready> = {}): Ready {
  return {
    phase: 'ready',
    head: 'main',
    detachedAt: null,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    branches: ['main'],
    files: [],
    staged: new Set<string>(),
    stat: { added: 0, removed: 0 },
    statuses: new Map(),
    unstaged: { added: 0, removed: 0 },
    ...over,
  }
}

describe('Git 工具那一格的事实', () => {
  test('干净仓库照样有事实：+0 -0，不是「这一格不画」', () => {
    const facts = workspaceGitFactsOf(ready(), picker)

    expect(facts).not.toBeNull()
    expect(facts?.status.added).toBe(0)
    expect(facts?.status.removed).toBe(0)
  })

  test('有增删时两个数照实报，且与清单同一份读数', () => {
    const facts = workspaceGitFactsOf(ready({ files: [], stat: { added: 12, removed: 4 } }), picker)

    expect(facts?.status.added).toBe(12)
    expect(facts?.status.removed).toBe(4)
  })

  test('不是 git 仓库 → 没有事实（这一格不存在）', () => {
    expect(workspaceGitFactsOf({ phase: 'notARepository' }, picker)).toBeNull()
  })

  test('还没读到 / 读失败 → 没有事实，不拿 0 冒充', () => {
    expect(workspaceGitFactsOf({ phase: 'asking' }, picker)).toBeNull()
    expect(workspaceGitFactsOf({ phase: 'unreadable' }, picker)).toBeNull()
  })

  test('分支与改动数来自同一份读数', () => {
    const reading: Extract<ReviewReading, { phase: 'ready' }> = ready({
      head: 'feature/x',
      branches: ['feature/x', 'main'],
      stat: { added: 3, removed: 1 },
    })
    /* picker 由这一份读数造出来（见 workspace-git-source 的 picker）：两者同源。 */
    const facts = workspaceGitFactsOf(reading, { ...picker, branch: reading.head, branches: reading.branches })

    expect(facts?.status.branch).toBe('feature/x')
    expect(facts?.status.branches).toEqual(['feature/x', 'main'])
    expect(facts?.status.added).toBe(3)
    /* 分支那一行读 picker、正文那一行读 status，两者是同一个分支名。 */
    expect(facts?.picker?.branch).toBe(facts?.status.branch)
  })
})
