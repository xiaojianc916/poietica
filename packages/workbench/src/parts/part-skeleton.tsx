import type { ReactNode } from 'react'

/** 懒加载贡献的兜底占位。外壳不认识任何功能，所以只画一枚中性的灰块，不猜「正在加载什么」。 */
export function PartSkeleton(): ReactNode {
  return <div aria-hidden="true" className="workbench__skeleton" data-workbench-part="skeleton" />
}
