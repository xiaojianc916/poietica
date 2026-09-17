import type { ReactNode } from 'react'

export interface SectionProps {
  readonly title: string
  readonly action?: ReactNode
  readonly children: ReactNode
}

export function Section({ action, children, title }: SectionProps) {
  return (
    <section className="pt-9">
      <div className="flex items-center gap-4 pb-4">
        <h2 className="shrink-0 text-[13px] font-medium">{title}</h2>
        <span
          aria-hidden="true"
          className="h-0 min-w-8 flex-1 border-t"
          style={{ borderColor: 'var(--ui-sunken)' }}
        />
        {action === undefined ? null : <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}
