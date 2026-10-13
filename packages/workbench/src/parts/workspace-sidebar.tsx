import { builtinPoints, FeatureScope, useContributions } from '@poietica/ui-kernel'
import { type ReactNode, Suspense } from 'react'
import { PartSkeleton } from './part-skeleton'
import { SidebarFooter } from './sidebar-footer'

/*
 * 侧栏内容：导航行由各功能自己贡献（`placement: 'nav'`），外壳一个产品常量都不写 ——
 * 缺省 placement 的条目落在中部面板那一格（线程列表，可滚动）；底部行是外壳家具。
 */
export function WorkspaceSidebar(): ReactNode {
  const sections = useContributions(builtinPoints.sidebarSections)
  const navItems = sections.filter((c) => c.item.placement === 'nav')
  const panels = sections.filter((c) => c.item.placement !== 'nav')
  return (
    <section className="workspace-sidebar flex h-full min-h-0 min-w-0 flex-col bg-sidebar">
      {navItems.length === 0 ? null : (
        <nav aria-label="主导航" className="workspace-sidebar__nav">
          <ul className="flex flex-col gap-px">
            {navItems.map((c) => (
              <li key={c.item.id}>
                <FeatureScope featureId={c.featureId}>
                  <Suspense fallback={<PartSkeleton />}>
                    <c.item.component />
                  </Suspense>
                </FeatureScope>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {/* 面板那一格：只有宿主先成了 flex 列，下面每个面板才有确定高度可滚（几何在 parts.css）。 */}
      <div className="workbench__sidebar-panels min-h-0 min-w-0 flex-1 overflow-hidden">
        {panels.length === 0 ? (
          <p className="workbench__empty" data-empty="sidebar">
            还没有任何功能
          </p>
        ) : (
          panels.map((c) => (
            <section className="workbench__sidebar-section" data-section={c.item.id} key={c.item.id}>
              <FeatureScope featureId={c.featureId}>
                <Suspense fallback={<PartSkeleton />}>
                  <c.item.component />
                </Suspense>
              </FeatureScope>
            </section>
          ))
        )}
      </div>

      <SidebarFooter />
    </section>
  )
}
