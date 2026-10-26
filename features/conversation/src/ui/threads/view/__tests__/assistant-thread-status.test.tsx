import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { AssistantThreadList, type AssistantThreadSummary } from '../assistant-thread-list'

/*
 * 会话行的状态记号（DSH StateDot 的同一套语义）：
 * - 行首一格只画一枚记号，优先级：待答交互 > 正在跑 > 定时任务来历；
 * - 待答的那一行，行尾相对时间让位给短标签；
 * - 完整说法（等待审批 / 计划待审 / 等待回答）始终给读屏。
 *
 * 只看颜色是分不出来的：这里钉的是读屏读得到的那句话。
 */

afterEach(cleanup)

function mount(items: readonly AssistantThreadSummary[], running: readonly string[] = []): HTMLElement {
  const view = render(
    <AssistantThreadList
      activeThreadId={null}
      archivedFilter="hide"
      collapsedWorkspaces={new Set()}
      groups={[{ id: 'w1', name: null, items }]}
      onActivate={() => undefined}
      onAddWorkspace={() => undefined}
      onArchivedFilterChange={() => undefined}
      onArchive={() => undefined}
      onCreate={() => undefined}
      onPin={() => undefined}
      onToggleWorkspace={() => undefined}
      runningThreadIds={new Set(running)}
    />,
  )

  return view.container
}

const AT = '2026-10-20T00:00:00.000Z'

function rowOf(container: HTMLElement, title: string): HTMLElement {
  const row = [...container.querySelectorAll('.assistant-thread')].find((node) => node.textContent?.includes(title))
  if (!(row instanceof HTMLElement)) throw new Error(`找不到会话行：${title}`)
  return row
}

describe('会话行：状态记号', () => {
  test('正在跑：读屏读得到「进行中」', () => {
    const view = mount([{ id: 't1', title: '跑着的', updatedAt: AT }], ['t1'])

    expect(rowOf(view, '跑着的').textContent).toContain('进行中')
  })

  test('空闲：行首没有状态说法，但行尾照旧有时间', () => {
    const view = mount([{ id: 't1', title: '闲着', updatedAt: AT }])
    const row = rowOf(view, '闲着')
    expect(row.textContent).not.toContain('进行中')
    expect(row.querySelector('time')).not.toBeNull()
  })

  test.each([
    ['approval', '等待审批', '待审批'],
    ['plan', '计划待审', '计划待审'],
    ['question', '等待回答', '待回答'],
  ] as const)('%s：待答抢在运行说法前面，行尾换成短标签', (pendingInteraction, spoken, compact) => {
    const view = mount([{ id: 't1', title: '等你的', updatedAt: AT, pendingInteraction }], ['t1'])
    const row = rowOf(view, '等你的')
    expect(row.textContent).not.toContain('进行中')
    expect(row.textContent).toContain(spoken)
    expect(row.querySelector('.assistant-thread__pending')?.textContent).toBe(compact)
    /* 待答时行尾不再报时间：同一个位置只说一句最要紧的。 */
    expect(row.querySelector('time')).toBeNull()
  })

  test('跑完但还没点开：绿点；一旦重新开跑，运行环把它顶掉', () => {
    const items = [{ id: 't1', title: '跑完了', updatedAt: AT, isDoneUnread: true }]
    const doneUnread = render(
      <AssistantThreadList
        activeThreadId={null}
        archivedFilter="hide"
        collapsedWorkspaces={new Set()}
        groups={[{ id: 'w1', name: null, items }]}
        onActivate={() => undefined}
        onAddWorkspace={() => undefined}
        onArchivedFilterChange={() => undefined}
        onArchive={() => undefined}
        onCreate={() => undefined}
        onPin={() => undefined}
        onToggleWorkspace={() => undefined}
        runningThreadIds={new Set()}
      />,
    )
    expect(rowOf(doneUnread.container, '跑完了').textContent).toContain('已完成，尚未查看')

    cleanup()
    const running = render(
      <AssistantThreadList
        activeThreadId={null}
        archivedFilter="hide"
        collapsedWorkspaces={new Set()}
        groups={[{ id: 'w1', name: null, items: [{ id: 't1', title: '跑完了', updatedAt: AT }] }]}
        onActivate={() => undefined}
        onAddWorkspace={() => undefined}
        onArchivedFilterChange={() => undefined}
        onArchive={() => undefined}
        onCreate={() => undefined}
        onPin={() => undefined}
        onToggleWorkspace={() => undefined}
        runningThreadIds={new Set(['t1'])}
      />,
    )
    const row = rowOf(running.container, '跑完了')
    expect(row.textContent).not.toContain('已完成，尚未查看')
    expect(row.textContent).toContain('进行中')
  })

  test('定时任务开的会话：安静时行首是闹钟；一旦开跑，运行环把它顶掉', () => {
    const record = {
      id: 't1',
      workspaceId: 'w1',
      title: '定时',
      titleSource: 'auto',
      posture: 'auto-edit',
      origin: 'automation',
      state: 'idle',
      pendingInteraction: null,
      hasSession: true,
      sessionId: 's1',
      forkedFrom: null,
      pinned: false,
      archived: false,
      createdAt: 0,
      updatedAt: 0,
    } as const

    const view = mount([{ id: 't1', title: '定时', updatedAt: AT, record }])
    expect(rowOf(view, '定时').querySelector('[aria-label="定时任务"]')).not.toBeNull()

    cleanup()
    const running = mount([{ id: 't1', title: '定时', updatedAt: AT, record }], ['t1'])
    expect(rowOf(running, '定时').querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(rowOf(running, '定时').querySelector('[aria-label="定时任务"]')).toBeNull()
  })
})
