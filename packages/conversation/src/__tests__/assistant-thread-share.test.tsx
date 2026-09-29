import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AssistantThreadList,
  type AssistantThreadListProps,
  threadMenuEntries,
} from '../surface/threads/assistant-thread-list'

/*
 * 菜单里「有哪几项」由 threadMenuEntries 一处判，所以这里直接钉它 —— 菜单本体是 Portal
 * 到 body 的，静态渲染里看不到那一层。
 * 「点了没反应的菜单项比不画更糟」是这一列的既定判据。
 */

const ALL_ACTIONS = {
  isPinned: false,
  canRename: true,
  canShare: true,
  canExport: true,
} as const

describe('分享菜单项', () => {
  it('上层给得出分享时,菜单里有这一项', () => {
    expect(threadMenuEntries(ALL_ACTIONS).map((entry) => entry.id)).toEqual([
      'pin',
      'rename',
      'share',
      'export',
    ])
  })

  it('上层给不出分享时,这一项不出现', () => {
    expect(threadMenuEntries({ ...ALL_ACTIONS, canShare: false }).map((entry) => entry.id)).toEqual(
      ['pin', 'rename', 'export'],
    )
  })

  it('分享排在本地导出之前:本机那件事先说', () => {
    const ids = threadMenuEntries(ALL_ACTIONS).map((entry) => entry.id)
    expect(ids.indexOf('share')).toBeLessThan(ids.indexOf('export'))
  })

  /*
   * 归档已挪到行尾那枚按钮上，菜单里不再有这一项 —— 一处动作一个落点，不同时挂两处。
   */
  it('归档不在菜单里:它已经是行尾的按钮', () => {
    const ids = threadMenuEntries(ALL_ACTIONS).map((entry) => entry.id)

    expect(ids).not.toContain('archive')
  })

  it('给不出动作的项一项都不画,固定与重命名照旧', () => {
    expect(
      threadMenuEntries({
        isPinned: true,
        canRename: false,
        canShare: false,
        canExport: false,
      }),
    ).toEqual([{ id: 'pin', label: '取消固定' }])
  })
})

const GROUP = [
  {
    id: '/workspace/project',
    name: 'project',
    items: [{ id: 'thread-1', title: '第一条对话', updatedAt: '2026-01-01T00:00:00.000Z' }],
  },
]

function renderList(props: Partial<AssistantThreadListProps> = {}): string {
  return renderToStaticMarkup(
    <AssistantThreadList
      activeThreadId={null}
      collapsedWorkspaces={new Set()}
      groups={GROUP}
      onActivate={() => undefined}
      onCreate={() => undefined}
      onPin={() => undefined}
      onToggleWorkspace={() => undefined}
      runningThreadIds={new Set()}
      {...props}
    />,
  )
}

describe('分享的界面落点', () => {
  it('正在上传时给得出「在跑」的样子', () => {
    const markup = renderList({ onShare: () => undefined, share: 'thread-1' })

    expect(markup).toContain('assistant-thread__sharing')
    expect(markup).toContain('正在上传到 my.omp.sh')
  })

  /*
   * 结果不再长在行里：上传成功后的提示与链接由宿主的横幅说，这一列只画会话。
   * 链接曾以一行小字挂在会话行下面，那段 UI 回来了这个判据就红。
   */
  it('结果不长在行里:这一列只画会话', () => {
    const markup = renderList({ onShare: () => undefined })

    expect(markup).not.toContain('assistant-thread__shared')
    expect(markup).not.toContain('my.omp.sh')
  })
})
