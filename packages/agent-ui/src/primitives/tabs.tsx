import './tabs.css'

import type { KeyboardEvent } from 'react'

import { cx } from './class-names'

/**
 * 分段切换：一组互斥的面，同时只画一个。
 *
 * 照 W3C ARIA Authoring Practices 的 Tabs Pattern 写：容器 role="tablist"，每一格
 * role="tab" 带 aria-selected，被切换的那一块 role="tabpanel"。焦点走 roving
 * tabindex —— 整组在 Tab 序列里只占一站，组内用左右方向键走，Home / End 直达两端。
 * 两个裸 <button> 这些都做不到，读屏也不会说「第 1 项，共 2 项」。
 *
 * 自动激活（方向键走到哪就切到哪）是 APG 给「面板内容取自本地、切换不昂贵」这一档
 * 的推荐做法；两个面都已经在内存里，正是这一档。
 *
 * 这一层只管一条切换条。面板由调用方画，id 由 tabId / panelId 两个纯函数配对，所以
 * 调用方不必自己拼字符串，也就拼不错。
 */

export interface TabOption {
  readonly id: string
  readonly label: string
}

export function tabId(baseId: string, id: string): string {
  return `${baseId}-tab-${id}`
}

export function panelId(baseId: string, id: string): string {
  return `${baseId}-panel-${id}`
}

/* 值写成可空，这张表本来就只认得两个键。 */
const STEP: Record<string, number | undefined> = { ArrowLeft: -1, ArrowRight: 1 }

export function TabList({
  activeId,
  baseId,
  className,
  label,
  onSelect,
  options,
}: {
  readonly activeId: string
  readonly baseId: string
  readonly className?: string
  readonly label: string
  readonly onSelect: (id: string) => void
  readonly options: readonly TabOption[]
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const count = options.length
    const from = options.findIndex((option) => option.id === activeId)
    const step = STEP[event.key]

    /* 位置先算出来再取值：越界与「这个键不归我管」在这里是同一件事。 */
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? count - 1
          : step === undefined
            ? -1
            : (from + step + count) % count

    const chosen: TabOption | undefined = next < 0 ? undefined : options[next]

    if (chosen === undefined) {
      return
    }

    event.preventDefault()

    /* tablist 的直接子元素就是这些按钮，顺序与 options 一致。 */
    const tab = event.currentTarget.children.item(next)

    if (tab instanceof HTMLElement) {
      tab.focus()
    }

    onSelect(chosen.id)
  }

  return (
    <div aria-label={label} className={cx('tabs', className)} onKeyDown={onKeyDown} role="tablist">
      {options.map((option) => {
        const isActive = option.id === activeId

        return (
          <button
            aria-controls={panelId(baseId, option.id)}
            aria-selected={isActive}
            className="tabs__tab"
            id={tabId(baseId, option.id)}
            key={option.id}
            onClick={() => {
              onSelect(option.id)
            }}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
