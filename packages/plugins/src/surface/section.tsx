import type { ReactNode } from 'react'

/*
 * 一段内容的抬头：左边标题与规模，右边一个可选动作。
 *
 * 三格与目录网格共用同一段结构。抬头写成六份，迟早有一份的字号与另外五份差一档，
 * 而那种差别没有任何测试看得见。
 */

export interface SectionProps {
  readonly title: string
  readonly count?: number | undefined
  readonly hint?: string | undefined
  readonly action?: ReactNode
  readonly children: ReactNode
}

export function Section({ action, children, count, hint, title }: SectionProps) {
  return (
    <section className="pt-9">
      <div className="flex items-center gap-4 pb-4">
        <div className="flex shrink-0 items-baseline gap-2">
          <h2 className="text-[13px] font-medium">{title}</h2>
          {count === undefined ? null : (
            <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
          )}
        </div>
        <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-divider/70" />
        {action === undefined ? null : <div className="shrink-0">{action}</div>}
      </div>
      {hint === undefined ? null : (
        <p className="pb-4 text-xs leading-5 text-muted-foreground">{hint}</p>
      )}
      {children}
    </section>
  )
}
