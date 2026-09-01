import { describe, expect, it } from 'bun:test'
import type { TodoItem } from '@poietica/conversation'
import { renderToStaticMarkup } from 'react-dom/server'
import { TodoListCard, todoProgressLabel } from '../todo/todo-panel'

const todos: readonly TodoItem[] = [
  { title: '搭骨架', status: 'done' },
  { title: '写组件', status: 'in_progress' },
  { title: '补测试', status: 'pending' },
]

describe('todo progress label', () => {
  it('joins per-status counts with en spaces around the separator', () => {
    expect(todoProgressLabel(todos)).toBe('1 已完成\u2002·\u20021 进行中\u2002·\u20021 待处理')
  })

  it('omits zero-count segments', () => {
    expect(todoProgressLabel([{ title: '完成', status: 'done' }])).toBe('1 已完成')
  })

  it('says nothing about an empty list', () => {
    expect(todoProgressLabel([])).toBe('')
  })
})

describe('TodoListCard', () => {
  it('starts as an accessible collapsed disclosure', () => {
    const markup = renderToStaticMarkup(<TodoListCard todos={todos} />)
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('1 已完成')
    expect(markup).not.toContain('写组件')
  })
})
