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
    <section className="pt-8">
      <div className="flex items-center justify-between gap-3 pb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-medium">{title}</h2>
          {count === undefined ? null : (
            <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
          )}
        </div>
        {action}
      </div>
      {hint === undefined ? null : (
        <p className="pb-3 text-xs leading-5 text-muted-foreground">{hint}</p>
      )}
      {children}
    </section>
  )
}
