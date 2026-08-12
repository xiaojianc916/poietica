import { cn } from '@poietica/ui'
import type { ReactNode } from 'react'

import { PluginGlyph } from './plugin-glyph'

/*
 * 「已安装」那张列表，三格共用。
 *
 * 三者在信息结构上是同一件事：一个标识、一个名字、一句说明、一枚来源标，外加各自的动作。
 *
 * 行是卡片不是表格行。这一页回答「我有什么」，不是一张设置表；卡片有悬停态，动作因此
 * 长在行上 —— 一键就能完成的事不该藏进「…」菜单的第二层。开关常驻、移除悬停浮出：
 * 前者是每天要拨的，后者不可逆。
 *
 * 自己不带页面内边距：外层容器已经有了，两处都写就是把列表右缩一格。
 */

export interface ContributionRow {
  readonly key: string
  readonly title: string
  readonly detail: string
  readonly badge?: string | undefined
  /** 有详情页的行才给。给了，名字就是一个可点的按钮。 */
  readonly onOpen?: (() => void) | undefined
  /** 关掉的那一行整行压暗：它还在，只是这一次不会装载。 */
  readonly dimmed?: boolean | undefined
  readonly trailing?: ReactNode
}

export interface ContributionListProps {
  readonly rows: readonly ContributionRow[]
  readonly empty: string
}

export function ContributionList({ empty, rows }: ContributionListProps) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-divider px-6 py-10 text-center text-xs leading-5 text-muted-foreground">
        {empty}
      </p>
    )
  }

  return (
    <ul className="grid gap-0.5">
      {rows.map((row) => (
        <li
          className={cn(
            'group flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted/60',
            row.dimmed === true ? 'opacity-55' : '',
          )}
          key={row.key}
        >
          <PluginGlyph displayName={row.title} id={row.key} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {row.onOpen === undefined ? (
                <span className="truncate text-[13px] font-medium">{row.title}</span>
              ) : (
                <button
                  className="truncate text-left text-[13px] font-medium hover:underline"
                  onClick={row.onOpen}
                  type="button"
                >
                  {row.title}
                </button>
              )}
              {row.badge === undefined ? null : (
                <span className="shrink-0 rounded-md border border-divider px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {row.badge}
                </span>
              )}
            </div>
            <p className="truncate pt-0.5 text-xs text-muted-foreground" title={row.detail}>
              {row.detail}
            </p>
          </div>
          {row.trailing === undefined ? null : (
            <div className="flex shrink-0 items-center gap-1.5">{row.trailing}</div>
          )}
        </li>
      ))}
    </ul>
  )
}
