import './disclosure.css'

import type { ReactNode } from 'react'
import { useCallback, useState } from 'react'

/**
 * 一段可以打开的内容。
 *
 * 默认开合是派生的：调用方给什么它就是什么。人点过一次之后以人为准 —— override
 * 落下就压过默认值，此后调用方说什么都不再算。
 */
export function useDisclosure(fallback: boolean): {
  readonly isOpen: boolean
  readonly toggle: () => void
} {
  const [override, setOverride] = useState<boolean | null>(null)

  const isOpen = override ?? fallback

  /*
   * 下一个值从上一个值算出来，不从这一帧的闭包里读：fallback 在流式期间每帧都可能
   * 翻面，同一批次里的两次点击若读同一份闭包会算出同一个值，面板于是不动。React
   * 官方对「用上一个 state 算下一个」只给更新函数这一种写法。
   */
  const toggle = useCallback(() => {
    setOverride((current) => !(current ?? fallback))
  }, [fallback])

  return { isOpen, toggle }
}

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
    <div className="disclosure__reveal" inert={!isOpen}>
      <div className="disclosure__clip">{children}</div>
    </div>
  )
}
