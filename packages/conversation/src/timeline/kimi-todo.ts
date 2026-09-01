import type { TodoItem } from './timeline-contract'

export function kimiTodoItemsOf(
  name: string | undefined,
  rawInput: unknown,
): readonly TodoItem[] | undefined {
  if (name !== 'TodoList') {
    return undefined
  }

  const input = parseInput(rawInput)
  if (typeof input !== 'object' || input === null) {
    return undefined
  }

  const rawTodos = Reflect.get(input, 'todos')
  if (!Array.isArray(rawTodos)) {
    return undefined
  }

  /* Kimi readTodoItems 语义：无效项被过滤，不伪造状态，也不因一项无效丢整份。 */
  const todos: TodoItem[] = []
  for (const rawTodo of rawTodos) {
    const todo = todoItemOf(rawTodo)
    if (todo !== null) {
      todos.push(todo)
    }
  }
  return todos
}

function parseInput(rawInput: unknown): unknown {
  if (typeof rawInput !== 'string' || rawInput.length === 0) {
    return rawInput
  }
  try {
    return JSON.parse(rawInput) as unknown
  } catch {
    return undefined
  }
}

function todoItemOf(value: unknown): TodoItem | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const title = Reflect.get(value, 'title')
  const status = Reflect.get(value, 'status')
  if (
    typeof title !== 'string' ||
    title.length === 0 ||
    (status !== 'pending' && status !== 'in_progress' && status !== 'done')
  ) {
    return null
  }
  return { title, status }
}
