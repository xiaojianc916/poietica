import type { BackgroundTaskItem, BackgroundTaskStatus, TodoItem } from '@poietica/conversation'
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from '@poietica/design-system'
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleX,
  ListTodo,
  Loader2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useAssistantBackgroundTasks, useAssistantTodos } from '../session/use-assistant-session'
import './todo-panel.css'

const TASK_STATUS_LABEL = {
  done: '已完成',
  in_progress: '进行中',
  pending: '待处理',
} as const

const BACKGROUND_STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  timed_out: '已超时',
  killed: '已停止',
  lost: '已中断',
}

export function todoProgressLabel(todos: readonly TodoItem[]): string {
  const done = todos.filter((item) => item.status === 'done').length
  const active = todos.filter((item) => item.status === 'in_progress').length
  const pending = todos.length - done - active
  return [
    ...(done > 0 ? [[String(done), TASK_STATUS_LABEL.done].join(' ')] : []),
    ...(active > 0 ? [[String(active), TASK_STATUS_LABEL.in_progress].join(' ')] : []),
    ...(pending > 0 ? [[String(pending), TASK_STATUS_LABEL.pending].join(' ')] : []),
  ].join(' · ')
}

export function backgroundTaskProgressLabel(tasks: readonly BackgroundTaskItem[]): string {
  const running = tasks.filter((task) => task.status === 'running').length
  const completed = tasks.filter((task) => task.status === 'completed').length
  const interrupted = tasks.length - running - completed
  return [
    ...(running > 0 ? [[String(running), '运行中'].join(' ')] : []),
    ...(completed > 0 ? [[String(completed), '已完成'].join(' ')] : []),
    ...(interrupted > 0 ? [[String(interrupted), '已中断'].join(' ')] : []),
  ].join(' · ')
}

function TodoStatusGlyph({ status }: { readonly status: TodoItem['status'] }) {
  if (status === 'done') {
    return <CheckCircle2 aria-hidden className="todo-panel__glyph--done" />
  }
  if (status === 'in_progress') {
    return <Loader2 aria-hidden className="todo-panel__glyph--progress" />
  }
  return <CircleDashed aria-hidden className="todo-panel__glyph--pending" />
}

function BackgroundStatusGlyph({ status }: { readonly status: BackgroundTaskStatus }) {
  if (status === 'running') {
    return <Loader2 aria-hidden className="todo-panel__glyph--progress" />
  }
  if (status === 'completed') {
    return <CheckCircle2 aria-hidden className="todo-panel__glyph--done" />
  }
  return <CircleX aria-hidden className="todo-panel__glyph--failed" />
}

function AccordionSection({
  children,
  icon,
  progress,
  title,
  value,
}: {
  readonly children: ReactNode
  readonly icon: ReactNode
  readonly progress: string
  readonly title: string
  readonly value: 'todos' | 'background'
}) {
  return (
    <AccordionItem className="todo-panel__section" value={value}>
      <AccordionHeader className="todo-panel__heading">
        <AccordionTrigger className="todo-panel__header">
          <span aria-hidden className="todo-panel__lead">
            {icon}
          </span>
          <span className="todo-panel__title">{title}</span>
          <span className="todo-panel__progress">{progress}</span>
          <ChevronRight aria-hidden className="todo-panel__chevron" />
        </AccordionTrigger>
      </AccordionHeader>
      <AccordionPanel className="todo-panel__body">
        <div className="todo-panel__region">{children}</div>
      </AccordionPanel>
    </AccordionItem>
  )
}

function TodoListCard({ todos }: { readonly todos: readonly TodoItem[] }) {
  return (
    <AccordionSection
      icon={<ListTodo />}
      progress={todoProgressLabel(todos)}
      title="待办事项"
      value="todos"
    >
      {todos.length === 0 ? (
        <p className="todo-panel__empty">暂无任务</p>
      ) : (
        <ul className="todo-panel__list">
          {todos.map((item, index) => (
            <li
              className="todo-panel__item"
              data-status={item.status}
              key={[String(index), item.title].join(':')}
            >
              <span
                aria-label={TASK_STATUS_LABEL[item.status]}
                className="todo-panel__glyph"
                role="img"
              >
                <TodoStatusGlyph status={item.status} />
              </span>
              <span className="todo-panel__content">{item.title}</span>
            </li>
          ))}
        </ul>
      )}
    </AccordionSection>
  )
}

function BackgroundTaskListCard({ tasks }: { readonly tasks: readonly BackgroundTaskItem[] }) {
  return (
    <AccordionSection
      icon={<Activity />}
      progress={backgroundTaskProgressLabel(tasks)}
      title="后台任务"
      value="background"
    >
      {tasks.length === 0 ? (
        <p className="todo-panel__empty">暂无后台任务</p>
      ) : (
        <ul className="todo-panel__list">
          {tasks.map((task) => (
            <li className="todo-panel__item" data-status={task.status} key={task.taskId}>
              <span
                aria-label={BACKGROUND_STATUS_LABEL[task.status]}
                className="todo-panel__glyph"
                role="img"
              >
                <BackgroundStatusGlyph status={task.status} />
              </span>
              <span className="todo-panel__copy">
                <span className="todo-panel__content">{task.description}</span>
                <span className="todo-panel__meta">{BACKGROUND_STATUS_LABEL[task.status]}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </AccordionSection>
  )
}

export function TaskPanelContent({
  backgroundTasks,
  todos,
}: {
  readonly backgroundTasks: readonly BackgroundTaskItem[]
  readonly todos: readonly TodoItem[]
}) {
  return (
    <Accordion className="todo-panel" defaultValue={[]}>
      <TodoListCard todos={todos} />
      <BackgroundTaskListCard tasks={backgroundTasks} />
    </Accordion>
  )
}

export function TodoPanel({ threadId }: { readonly threadId: string }) {
  const todos = useAssistantTodos(threadId)
  const backgroundTasks = useAssistantBackgroundTasks(threadId)
  return <TaskPanelContent backgroundTasks={backgroundTasks} todos={todos} />
}
