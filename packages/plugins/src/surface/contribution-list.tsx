import type { ReactNode } from 'react'

/**
 * 技能与 MCP 两格共用的那张列表。
 *
 * 两者在信息结构上是同一件事：一个名字、一句说明、一个来源标，外加 MCP 多一个开关。
 * 写成两份几乎一样的列表，迟早在其中一份上改漏一处。
 *
 * 标签收的是已经描述好的字符串而不是来源对象：这张列表不需要知道来源有几种，
 * 那是 origin 那一处的事。
 */

export interface ContributionRow {
  readonly key: string
  readonly title: string
  readonly detail: string
  readonly badge: string
  readonly trailing?: ReactNode
}

export interface ContributionListProps {
  readonly rows: readonly ContributionRow[]
  readonly empty: string
}

export function ContributionList({ rows, empty }: ContributionListProps) {
  if (rows.length === 0) {
    return <p className="px-8 py-10 text-xs text-muted-foreground">{empty}</p>
  }

  return (
    <ul className="px-8">
      {rows.map((row) => (
        <li
          className="flex items-center gap-4 border-b border-divider py-3 last:border-b-0"
          key={row.key}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{row.title}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{row.detail}</p>
          </div>

          <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {row.badge}
          </span>

          {row.trailing}
        </li>
      ))}
    </ul>
  )
}
