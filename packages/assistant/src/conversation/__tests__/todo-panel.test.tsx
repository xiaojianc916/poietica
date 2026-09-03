import { describe, expect, it } from 'bun:test'
import type { BackgroundTaskItem, TodoItem } from '@poietica/conversation'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  backgroundTaskProgressLabel,
  TaskPanelContent,
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

const manyTasks: readonly BackgroundTaskItem[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(
  (taskId, index) => ({
    description: `后台任务${index + 1}`,
    status: index % 2 === 0 ? 'completed' : 'running',
    taskId,
  }),
)

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

describe('task accordion', () => {
  it('renders both sections in one collapsed accordion', () => {
    const markup = renderToStaticMarkup(<TaskPanelContent backgroundTasks={tasks} todos={todos} />)
    expect(markup.match(/class="todo-panel"/g)).toHaveLength(1)
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(2)
    expect(markup).toContain('待办事项')
    expect(markup).toContain('后台任务')
    expect(markup).not.toContain('<details')
  })

  it('marks lists taller than six rows as having more below', () => {
    const crowded = renderToStaticMarkup(
      <TaskPanelContent backgroundTasks={manyTasks} todos={todos} />,
    )
    expect(crowded).toContain('data-more="true"')

    const roomy = renderToStaticMarkup(<TaskPanelContent backgroundTasks={tasks} todos={todos} />)
    expect(roomy).not.toContain('data-more')
  })
})
