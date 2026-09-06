import './disclosure.css'

import type { ReactNode } from 'react'

/**
 * The travelling part of a disclosure.
 *
 * 收起就不在 DOM 里：抽屉里装的是整份载荷（markdown、diff），留着它等于每次挂载、
 * 每次重排、每次重绘都替看不见的内容付一遍钱。开合不补间 —— 这一行挂着虚拟器的
 * measureElement。
 */
export function DisclosureBody({
  children,
  isOpen,
}: {
  readonly children: ReactNode
  readonly isOpen: boolean
}) {
  return isOpen ? children : null
}
