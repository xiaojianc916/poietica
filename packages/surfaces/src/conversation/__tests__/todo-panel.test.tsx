import { describe, expect, it } from 'bun:test'
import type { TodoItem } from '@poietica/conversation'
import { renderToStaticMarkup } from 'react-dom/server'
import { TodoPanel, todoProgressLabel } from '../todo/todo-panel'

const todos: readonly TodoItem[] = [
  { title: '搭骨架', status: 'done' },
  { title: '写组件', status: 'in_progress' },
  { title: '补测试', status: 'pending' },
]

describe('todo panel', () => {
  it('renders nothing for an empty list', () => {
    expect(renderToStaticMarkup(<TodoPanel todos={[]} />)).toBe('')
  })

  it('starts collapsed with the per-status summary visible', () => {
    const markup = renderToStaticMarkup(<TodoPanel todos={todos} />)

    expect(markup).toContain('1 已完成 · 1 进行中 · 1 待处理')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('搭骨架')
  })

  it('omits zero-count summary segments', () => {
    expect(todoProgressLabel([{ title: '完成', status: 'done' }])).toBe('1 已完成')
  })
})
