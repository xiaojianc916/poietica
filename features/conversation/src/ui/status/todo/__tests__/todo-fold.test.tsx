import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TaskPanelContent } from '../todo-panel'

afterEach(cleanup)

/* 折起来的「已完成 N 项」「待处理 N 项」：键盘聚焦（与悬停同一个触发器）时悬浮卡逐条列出被折起来的那几项。 */
test('聚焦折叠行时悬浮卡列出被折起来的待办', async () => {
  const view = render(
    <TaskPanelContent
      backgroundTasks={[]}
      todos={[
        { title: '读代码', status: 'done' },
        { title: '跑测试', status: 'done' },
        { title: '改实现', status: 'in_progress' },
        { title: '补测试', status: 'pending' },
        { title: '写文档', status: 'pending' },
        { title: '发版本', status: 'pending' },
        { title: '回访用户', status: 'pending' },
      ]}
    />,
  )
  expect(document.body.textContent).not.toContain('读代码')
  const [preceding, following] = [...view.container.querySelectorAll('button.status-panel__fold')]
  expect(preceding?.textContent).toBe('已完成 2 项')
  expect(following?.textContent).toBe('待处理 2 项')

  fireEvent.focus(preceding as HTMLElement)
  await waitFor(() => {
    expect(document.body.textContent).toContain('读代码')
  })
  expect(document.body.textContent).toContain('跑测试')

  fireEvent.blur(preceding as HTMLElement)
  fireEvent.focus(following as HTMLElement)
  await waitFor(() => {
    expect(document.body.textContent).toContain('回访用户')
  })
  expect(document.body.textContent).toContain('发版本')
})
