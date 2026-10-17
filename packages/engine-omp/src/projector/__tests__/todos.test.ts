import { describe, expect, test } from 'bun:test'
import { OMP_TODO_ID, TodoMirror, todoItemsOf } from '../todos'

const phases = (...statuses: string[]) => [
  { name: '阶段一', tasks: statuses.map((status, index) => ({ content: `第 ${String(index + 1)} 件`, status })) },
]

describe('todoItemsOf', () => {
  test('五档 → 三档；abandoned 不列；跨阶段平铺', () => {
    const items = todoItemsOf([
      ...phases('completed', 'in_progress', 'pending'),
      {
        name: '阶段二',
        tasks: [
          { content: '受阻', status: 'blocked' },
          { content: '放弃', status: 'abandoned' },
        ],
      },
    ])
    expect(items).toEqual([
      { title: '第 1 件', status: 'done' },
      { title: '第 2 件', status: 'in_progress' },
      { title: '第 3 件', status: 'pending' },
      { title: '受阻', status: 'pending' },
    ])
  })

  test('认不出的形状当缺席', () => {
    expect(todoItemsOf(undefined)).toEqual([])
    expect(todoItemsOf([{ tasks: [{ content: '', status: 'pending' }, { status: 'pending' }, null] }])).toEqual([])
  })
})

describe('TodoMirror', () => {
  test('首次空表不发；变了整张替换；没变不发', () => {
    const mirror = new TodoMirror(() => 1_700_000_000_000)
    expect(mirror.sync([])).toEqual([])
    expect(mirror.current).toBeNull()
    const first = mirror.sync(phases('pending', 'pending'))
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ op: 'todo.upsert', todo: { todoId: OMP_TODO_ID } })
    expect(mirror.sync(phases('pending', 'pending'))).toEqual([])
    expect(mirror.sync(phases('completed', 'in_progress'))).toHaveLength(1)
    expect(mirror.current?.items.map((item) => item.status)).toEqual(['done', 'in_progress'])
  })

  test('自动清空（omp 的 todo_auto_clear）发一张空表，面板跟着收掉', () => {
    const mirror = new TodoMirror(() => 0)
    mirror.sync(phases('completed'))
    const cleared = mirror.sync([])
    expect(cleared).toHaveLength(1)
    expect(mirror.current?.items).toEqual([])
  })
})
