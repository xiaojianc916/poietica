import type { TodoItem } from '@poietica/conversation'
import { ListTodo, X } from 'lucide-react'
import { useId } from 'react'
import { useAssistantTodos } from '../session/use-assistant-session'
import './todo-panel.css'

const STATUS_LABEL = {
  done: '已完成',
  in_progress: '进行中',
  pending: '待处理',
} as const

/** 关闭联合的兜底：状态由 kap 投影守卫，走到这里说明契约被绕过了。 */
function unreachable(status: never): never {
  throw new Error(`未知的待办状态：${String(status)}`)
}

/* 三枚字形共用 14×14 画板（照搬 DeepSeek Harness 的 figma 尺寸），16px 格居中。 */
function CompletedGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="todo-panel__glyph--done"
      fill="none"
      height={14}
      viewBox="0 0 14 14"
      width={14}
    >
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** 进行中：一圈渐隐的环，旋转交给 CSS。 */
function ProgressGlyph() {
  const gradientId = useId()

  return (
    <svg
      aria-hidden="true"
      className="todo-panel__glyph--progress"
      fill="none"
      height={14}
      viewBox="0 0 14 14"
      width={14}
    >
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={gradientId}
          x1="2.5"
          x2="10.5"
          y1="12"
          y2="3.5"
        >
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="7" cy="7" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
    </svg>
  )
}

/** 待处理：虚线环，dash 2.4 2.4。 */
function PendingGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="todo-panel__glyph--pending"
      fill="none"
      height={14}
      viewBox="0 0 14 14"
      width={14}
    >
      <circle
        cx="7"
        cy="7"
        r="6.4"
        stroke="currentColor"
        strokeDasharray="2.4 2.4"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function StatusGlyph({ status }: { readonly status: TodoItem['status'] }) {
  switch (status) {
    case 'done': {
      return <CompletedGlyph />
    }

    case 'in_progress': {
      return <ProgressGlyph />
    }

    case 'pending': {
      return <PendingGlyph />
    }

    default: {
      return unreachable(status)
    }
  }
}

/**
 * 分状态计数，用 en space 包住间隔点（照搬 Harness：HTML 会吃掉连续的 ASCII
 * 空格，要宽一点只能用宽空格）。为零的那一段不出现 —— 非空清单至少留一段。
 */
export function todoProgressLabel(todos: readonly TodoItem[]): string {
  const done = todos.filter((item) => item.status === 'done').length
  const active = todos.filter((item) => item.status === 'in_progress').length
  const pending = todos.length - done - active

  return [
    ...(done > 0 ? [`${done} ${STATUS_LABEL.done}`] : []),
    ...(active > 0 ? [`${active} ${STATUS_LABEL.in_progress}`] : []),
    ...(pending > 0 ? [`${pending} ${STATUS_LABEL.pending}`] : []),
  ].join(' · ')
}

/**
 * 这条对话的待办清单。
 *
 * 清单的唯一真相是 timeline 投影的 todos，这一层只订阅它 —— 没有本地副本，
 * 也没有增删改：待办由 agent 的 todo_list 工具整表替换。几何归外面那一列，
 * 这里只画内容。
 */
export function TodoPanel({
  onClose,
  threadId,
}: {
  readonly onClose: () => void
  readonly threadId: string
}) {
  const todos = useAssistantTodos(threadId)

  return (
    <section aria-label="任务" className="todo-panel">
      <header className="todo-panel__header">
        <span aria-hidden className="todo-panel__lead">
          <ListTodo />
        </span>
        <h2 className="todo-panel__title">任务</h2>
        <span className="todo-panel__progress">{todoProgressLabel(todos)}</span>
        <button
          aria-label="关闭任务"
          className="todo-panel__close"
          onClick={onClose}
          title="关闭任务"
          type="button"
        >
          <X aria-hidden />
        </button>
      </header>

      {todos.length === 0 ? (
        <p className="todo-panel__empty">暂无任务</p>
      ) : (
        <ul className="todo-panel__list">
          {todos.map((item) => (
            <li className="todo-panel__item" data-status={item.status} key={item.title}>
              <span aria-label={STATUS_LABEL[item.status]} className="todo-panel__glyph" role="img">
                <StatusGlyph status={item.status} />
              </span>
              <span className="todo-panel__content">{item.title}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
