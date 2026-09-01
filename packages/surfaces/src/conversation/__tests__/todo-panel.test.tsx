import { describe, expect, it } from 'bun:test'
import type { BackgroundTaskItem, TodoItem } from '@poietica/conversation'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BackgroundTaskListCard,
  backgroundTaskProgressLabel,
  TodoListCard,
  todoProgressLabel,
} from '../todo/todo-panel'

const todos: readonly TodoItem[] = [
  { title: '搭骨架', status: 'done' },
  { title: '写组件', status: 'in_progress' },
  { title: '补测试', status: 'pending' },
]

const tasks: readonly BackgroundTaskItem[] = [
  { taskId: 'a', description: '索引仓库', status: 'running' },
  { taskId: 'b', description: '执行测试', status: 'completed' },
  { taskId: 'c', description: '生成报告', status: 'failed' },
]

describe('task panel labels', () => {
  it('summarizes todo states', () => {
    expect(todoProgressLabel(todos)).toBe('1 已完成\u2002·\u20021 进行中\u2002·\u20021 待处理')
  })
  it('summarizes background lifecycle states', () => {
    expect(backgroundTaskProgressLabel(tasks)).toBe(
      '1 运行中\u2002·\u20021 已完成\u2002·\u20021 已中断',
    )
  })
})

describe('native disclosures', () => {
  it('renders todo and background cards collapsed by default', () => {
    const todoMarkup = renderToStaticMarkup(<TodoListCard todos={todos} />)
    const taskMarkup = renderToStaticMarkup(<BackgroundTaskListCard tasks={tasks} />)
    expect(todoMarkup).toContain('<details class="todo-panel">')
    expect(taskMarkup).toContain('后台任务')
    expect(todoMarkup).not.toContain(' open=""')
    expect(taskMarkup).not.toContain(' open=""')
  })
})
