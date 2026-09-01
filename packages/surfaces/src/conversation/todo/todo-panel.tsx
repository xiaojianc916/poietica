import './todo-panel.css'

import type { TodoItem, TodoStatus } from '@poietica/conversation'
import { ChevronDown, ChevronUp, ListTodo } from 'lucide-react'
import { useId, useState } from 'react'
import { useAssistantTodos } from '../session/use-assistant-session'

export interface TodoPanelProps {
  readonly todos: readonly TodoItem[]
}

const STATUS_LABEL: Readonly<Record<TodoStatus, string>> = {
  done: '已完成',
  in_progress: '进行中',
  pending: '待处理',
}

function unreachable(status: never): never {
  throw new Error(`unreachable todo status: ${String(status)}`)
}

function CompletedGlyph() {
  return (
    <svg
      aria-hidden
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

function ProgressGlyph() {
  const gradientId = useId()

  return (
    <svg
      aria-hidden
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

function PendingGlyph() {
  return (
    <svg
      aria-hidden
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

function StatusGlyph({ status }: { readonly status: TodoStatus }) {
  switch (status) {
    case 'done':
      return <CompletedGlyph />
    case 'in_progress':
      return <ProgressGlyph />
    case 'pending':
      return <PendingGlyph />
    default:
      return unreachable(status)
  }
}

export function todoProgressLabel(todos: readonly TodoItem[]): string {
  let done = 0
  let active = 0
  let pending = 0

  for (const item of todos) {
    if (item.status === 'done') {
      done += 1
    } else if (item.status === 'in_progress') {
      active += 1
    } else {
      pending += 1
    }
  }

  return [
    ...(done === 0 ? [] : [`${done} 已完成`]),
    ...(active === 0 ? [] : [`${active} 进行中`]),
    ...(pending === 0 ? [] : [`${pending} 待处理`]),
  ].join(' · ')
}

export function TodoPanel({ todos }: TodoPanelProps) {
  const [collapsed, setCollapsed] = useState(true)
  const listId = useId()

  if (todos.length === 0) {
    return null
  }

  return (
    <section aria-label="任务" className="todo-panel">
      <div className="todo-panel__body">
        <button
          aria-controls={listId}
          aria-expanded={!collapsed}
          className="todo-panel__header"
          onClick={() => {
            setCollapsed((value) => !value)
          }}
          type="button"
        >
          <span aria-hidden className="todo-panel__lead">
            <ListTodo size={14} strokeWidth={1.5} />
          </span>
          <span className="todo-panel__title">任务</span>
          <span className="todo-panel__progress">{todoProgressLabel(todos)}</span>
          <span aria-hidden className="todo-panel__chevron">
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>

        {collapsed ? null : (
          <ul className="todo-panel__list" id={listId}>
            {todos.map((item) => (
              <li
                aria-label={`${STATUS_LABEL[item.status]}：${item.title}`}
                className="todo-panel__item"
                data-status={item.status}
                key={item.title}
              >
                <span aria-hidden className="todo-panel__glyph">
                  <StatusGlyph status={item.status} />
                </span>
                <span className="todo-panel__content">{item.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

export function TodoPane({ threadId }: { readonly threadId: string }) {
  const todos = useAssistantTodos(threadId)

  return (
    <div className="todo-pane" data-assistant-skin>
      {todos.length === 0 ? (
        <div className="todo-pane__empty">
          <ListTodo aria-hidden size={24} strokeWidth={1.25} />
          <span>暂无任务</span>
        </div>
      ) : (
        <TodoPanel todos={todos} />
      )}
    </div>
  )
}
