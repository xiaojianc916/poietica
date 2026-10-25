import type { TranscriptTodoItem as TodoItem, TranscriptOperation, TranscriptTodo } from '@poietica/transcript'

/*
 * omp 的待办（todo 工具维护的 TodoPhase[]）→ transcript 的 `todo.upsert`。
 * **真身是 omp 会话里的那份 phases**（`session.getTodoPhases()`）：自动清空（todo_auto_clear）、
 * 换会话、打开会话改的都是它。这里不解析工具参数、不重放操作 —— 自己重放就是第二份状态机，
 * omp 的修复（repairTodoParams）、拒收、部分应用都对不上。纯函数 + 去重的小账，不碰 SDK。
 */

/** 这条会话只有一份待办：omp 一条会话就一张 phases 表 */
export const OMP_TODO_ID = 'omp.todo'

/**
 * omp 的五档 → 产品的三档：
 * - completed → done；in_progress → in_progress；
 * - pending / blocked → pending（受阻的仍是没做完的事，面板上不该消失，也不该算「进行中」）；
 * - abandoned → 不列（omp 自己的渲染也把它划掉不计进度；算进分母会让「3/4 完成」永远到不了头）。
 */
function statusOf(raw: unknown): TodoItem['status'] | null {
  switch (raw) {
    case 'completed':
      return 'done'
    case 'in_progress':
      return 'in_progress'
    case 'pending':
    case 'blocked':
      return 'pending'
    default:
      return null
  }
}

function tasksOf(phase: unknown): readonly unknown[] {
  const tasks = typeof phase === 'object' && phase !== null ? (phase as { readonly tasks?: unknown }).tasks : undefined
  return Array.isArray(tasks) ? tasks : []
}

function itemOf(task: unknown): TodoItem | null {
  if (typeof task !== 'object' || task === null) return null
  const { content, status } = task as { readonly content?: unknown; readonly status?: unknown }
  const mapped = statusOf(status)
  if (typeof content !== 'string' || content.trim() === '' || mapped === null) return null
  return { title: content, status: mapped }
}

/** phases → 平铺的条目（面板只画一列；分组名不进条目，免得每一条都拖一个前缀） */
export function todoItemsOf(phases: unknown): readonly TodoItem[] {
  if (!Array.isArray(phases)) return []
  return phases.flatMap((phase) =>
    tasksOf(phase).flatMap((task) => {
      const item = itemOf(task)
      return item === null ? [] : [item]
    }),
  )
}

/**
 * 去重的小账：omp 每一次 todo 调用、每一次自动清空都可能交回同一张表，没变就不发 op；变了整张替换（`todo.upsert` 是整格替换）。
 * `current` 供整页快照用：重订阅、Core 重启后的那一页也要带上这份待办，否则面板要等到下一次 todo 调用才出现。
 */
export class TodoMirror {
  private last: TranscriptTodo | null = null

  constructor(private readonly now: () => number) {}

  get current(): TranscriptTodo | null {
    return this.last
  }

  sync(phases: unknown): TranscriptOperation[] {
    const items = todoItemsOf(phases)
    /* 从来没有过待办、此刻也是空表：不发（新会话不必收一条空的 todo.upsert） */
    if (this.last === null && items.length === 0) return []
    if (this.last !== null && sameItems(this.last.items, items)) return []
    const todo: TranscriptTodo = { todoId: OMP_TODO_ID, items, updatedAt: new Date(this.now()).toISOString() }
    this.last = todo
    return [{ op: 'todo.upsert', todo }]
  }
}

function sameItems(left: readonly TodoItem[], right: readonly TodoItem[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item.title === right[index]?.title && item.status === right[index]?.status)
  )
}
