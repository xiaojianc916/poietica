import './disclosure.css'

import type { ReactNode } from 'react'

/**
 * The travelling part of a disclosure.
 *
 * 内容常驻挂载，开合是轨道在 0fr 与 1fr 之间的一次跳变，不补间（disclosure.css）。
 * 收起时整块 inert：键盘与读屏都到不了它。
 */
export function DisclosureBody({
  children,
  isOpen,
}: {
  readonly children: ReactNode
  readonly isOpen: boolean
}) {
  return (
    <div className="disclosure__reveal" data-open={isOpen ? 'true' : undefined} inert={!isOpen}>
      <div className="disclosure__clip">{children}</div>
    </div>
  )
}
