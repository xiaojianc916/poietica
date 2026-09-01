import type { TodoItem } from '@poietica/conversation'
import { useId, useState } from 'react'
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

function ChecklistGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height={14} viewBox="0 0 14 14" width={14}>
      <path d="M13.3277 9.69629V10.976H7.28086V9.69629H13.3277Z" fill="currentColor" />
      <path d="M13.3277 2.97256V4.25225H7.28086V2.97256H13.3277Z" fill="currentColor" />
      <path
        d="M4.64512 10.336C4.64505 9.62755 4.07081 9.05322 3.3623 9.05322C2.65386 9.05329 2.07956 9.62759 2.07949 10.336C2.07949 11.0445 2.65382 11.6188 3.3623 11.6188C4.07085 11.6188 4.64512 11.0446 4.64512 10.336ZM5.92559 10.336C5.92559 11.7515 4.77777 12.8993 3.3623 12.8993C1.94689 12.8993 0.799805 11.7515 0.799805 10.336C0.799871 8.92066 1.94693 7.7736 3.3623 7.77354C4.77773 7.77354 5.92552 8.92062 5.92559 10.336Z"
        fill="currentColor"
      />
      <path
        d="M4.64531 3.6123C4.6453 2.90382 4.07098 2.32949 3.3625 2.32949C2.65403 2.32951 2.0797 2.90383 2.07969 3.6123C2.07969 4.32079 2.65402 4.8951 3.3625 4.89512C4.07099 4.89512 4.64531 4.3208 4.64531 3.6123ZM5.925 3.6123C5.925 5.02772 4.77792 6.1748 3.3625 6.1748C1.9471 6.17479 0.8 5.02771 0.8 3.6123C0.800013 2.19691 1.9471 1.04982 3.3625 1.0498C4.77791 1.0498 5.92499 2.1969 5.925 3.6123Z"
        fill="currentColor"
      />
    </svg>
  )
}

function ChevronGlyph({ expanded }: { readonly expanded: boolean }) {
  const path = expanded
    ? 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'
    : 'M2.15137 8.5L2.57617 8.07617L5.30273 5.34863C5.55843 5.09294 5.78438 4.86618 5.98828 4.70215C6.20088 4.53117 6.44405 4.38244 6.75 4.33398C6.91565 4.30778 7.08435 4.30778 7.25 4.33398C7.55595 4.38244 7.79912 4.53117 8.01172 4.70215C8.21561 4.86618 8.44157 5.09294 8.69727 5.34863L11.4238 8.07617L11.8486 8.5L11 9.34863L10.5762 8.92383L7.84863 6.19727C7.57405 5.92269 7.40124 5.75152 7.25977 5.6377C7.12709 5.53096 7.07728 5.52187 7.0625 5.51953C7.02105 5.51297 6.97895 5.51297 6.9375 5.51953C6.92272 5.52187 6.87291 5.53096 6.74023 5.6377C6.59876 5.75152 6.42595 5.92268 6.15137 6.19727L3.42383 8.92383L3 9.34863L2.15137 8.5Z'
  return (
    <svg aria-hidden="true" fill="none" height={14} viewBox="0 0 14 14" width={14}>
      <path d={path} fill="currentColor" />
    </svg>
  )
}

/* 状态字形共用 14×14 画板并居中在 16px 网格。 */
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

export function TodoListCard({ todos }: { readonly todos: readonly TodoItem[] }) {
  const [collapsed, setCollapsed] = useState(true)
  const label = collapsed ? '展开任务' : '折叠任务'

  return (
    <section aria-label="任务" className="todo-panel">
      <button
        aria-expanded={!collapsed}
        aria-label={label}
        className="todo-panel__header"
        onClick={() => setCollapsed((current) => !current)}
        title={label}
        type="button"
      >
        <span aria-hidden className="todo-panel__lead">
          <ChecklistGlyph />
        </span>
        <span className="todo-panel__title">任务</span>
        <span className="todo-panel__progress">{todoProgressLabel(todos)}</span>
        <span aria-hidden className="todo-panel__chevron">
          <ChevronGlyph expanded={!collapsed} />
        </span>
      </button>

      {!collapsed &&
        (todos.length === 0 ? (
          <p className="todo-panel__empty">暂无任务</p>
        ) : (
          <ul className="todo-panel__list">
            {todos.map((item, _index) => (
              <li
                className="todo-panel__item"
                data-status={item.status}
                key={[item.title, item.status].join(':')}
              >
                <span
                  aria-label={STATUS_LABEL[item.status]}
                  className="todo-panel__glyph"
                  role="img"
                >
                  <StatusGlyph status={item.status} />
                </span>
                <span className="todo-panel__content">{item.title}</span>
              </li>
            ))}
          </ul>
        ))}
    </section>
  )
}

/** 会话订阅只负责把 timeline 的只读快照交给纯内容视图。 */
export function TodoPanel({ threadId }: { readonly threadId: string }) {
  const todos = useAssistantTodos(threadId)
  return <TodoListCard todos={todos} />
}
