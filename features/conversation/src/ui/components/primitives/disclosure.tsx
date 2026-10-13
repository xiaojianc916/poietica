import './disclosure.css'

import type { ReactNode } from 'react'

/**
 * 收起即从 DOM 移除：抽屉里是整份载荷（markdown、diff），留着等于替看不见的内容付挂载与重绘；
 * 也因此不能做开合补间 —— 这一行挂着虚拟器的 measureElement。
 */
export function DisclosureBody({ children, isOpen }: { readonly children: ReactNode; readonly isOpen: boolean }) {
  return isOpen ? children : null
}
