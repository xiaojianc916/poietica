import './tabs.css'

import type { KeyboardEvent } from 'react'

import { cx } from './class-names'

/**
 * 分段切换。照 W3C ARIA APG 的 Tabs Pattern：role 三件套 + aria-selected + roving tabindex
 * （整组在 Tab 序列里只占一站，方向键走、Home / End 直达两端）—— 两个裸 <button> 读屏
 * 不会说「第 1 项，共 2 项」。自动激活是 APG 对「面板取自本地、切换不昂贵」这一档的推荐。
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

    /* 越界与「这个键不归我管」在这里是同一件事：next 为 -1 就什么都不做。 */
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

    /* tablist 的直接子元素就是这些按钮，顺序与 options 一致，所以下标能对上 next。 */
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
