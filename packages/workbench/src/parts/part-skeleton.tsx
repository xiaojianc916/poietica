import type { ReactNode } from 'react'

/**
 * 懒加载贡献的兜底占位（06 页 §6.2：贡献组件一律包 `<Suspense fallback={<PartSkeleton/>}>`）。
 *
 * 外壳不认识任何功能，所以这里只画一枚中性的灰块（样式见 parts.css 的 `.workbench__skeleton`），
 * 不猜「正在加载什么」。
 */
export function PartSkeleton(): ReactNode {
  return <div aria-hidden="true" className="workbench__skeleton" data-workbench-part="skeleton" />
}
