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
  canArchive: true,
} as const

describe('分享菜单项', () => {
  it('上层给得出分享时,菜单里有这一项', () => {
    expect(threadMenuEntries(ALL_ACTIONS).map((entry) => entry.id)).toEqual([
      'pin',
      'rename',
      'share',
      'export',
      'archive',
    ])
  })

  it('上层给不出分享时,这一项不出现', () => {
    expect(threadMenuEntries({ ...ALL_ACTIONS, canShare: false }).map((entry) => entry.id)).toEqual(
      ['pin', 'rename', 'export', 'archive'],
    )
  })

  it('分享排在本地导出之前:本机那件事先说', () => {
    const ids = threadMenuEntries(ALL_ACTIONS).map((entry) => entry.id)
    expect(ids.indexOf('share')).toBeLessThan(ids.indexOf('export'))
  })

  it('给不出动作的项一项都不画,固定与重命名照旧', () => {
    expect(
      threadMenuEntries({
        isPinned: true,
        canRename: false,
        canShare: false,
        canExport: false,
        canArchive: false,
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

const SHARED_URL = 'https://my.omp.sh/s/abc123#secret'

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

describe('分享链接的落点', () => {
  it('链接到手后,这一行把链接说出来 —— 用户拿得到它,而不是点了什么都没发生', () => {
    const markup = renderList({
      onShare: () => undefined,
      shared: { threadId: 'thread-1', url: SHARED_URL, truncated: false },
    })

    expect(markup).toContain(SHARED_URL)
    expect(markup).toContain('已上传到 my.omp.sh')
    expect(markup).toContain('链接已复制')
  })

  it('被裁剪过就如实说,不装成完整的一份', () => {
    const markup = renderList({
      onShare: () => undefined,
      shared: { threadId: 'thread-1', url: SHARED_URL, truncated: true },
    })

    expect(markup).toContain('已截短')
    expect(markup).toContain(SHARED_URL)
  })

  it('链接只长在它自己那一行下,不挂到别的对话上', () => {
    const markup = renderList({
      onShare: () => undefined,
      groups: [
        {
          ...GROUP[0]!,
          items: [
            ...GROUP[0]!.items,
            { id: 'thread-2', title: '第二条对话', updatedAt: '2026-01-01T00:00:01.000Z' },
          ],
        },
      ],
      shared: { threadId: 'thread-2', url: SHARED_URL, truncated: false },
    })

    expect(markup.match(/assistant-thread__shared-url/g)).toHaveLength(1)
  })

  it('正在上传时给得出「在跑」的样子', () => {
    const markup = renderList({ onShare: () => undefined, share: 'thread-1' })

    expect(markup).toContain('assistant-thread__sharing')
    expect(markup).toContain('正在上传到 my.omp.sh')
  })

  it('还没分享成功时,链接与提示一个字都不出来', () => {
    const markup = renderList({ onShare: () => undefined })

    expect(markup).not.toContain('assistant-thread__shared')
    expect(markup).not.toContain('my.omp.sh')
  })
})
