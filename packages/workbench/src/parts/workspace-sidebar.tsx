import { builtinPoints, FeatureScope, useContributions } from '@poietica/ui-kernel'
import { type ReactNode, Suspense } from 'react'
import { PartSkeleton } from './part-skeleton'
import { SidebarFooter } from './sidebar-footer'

/**
 * 侧栏内容。**迁移自** legacy `shell/sidebar/workspace-sidebar.tsx` 的三段结构
 * （导航 / 面板 / 底部行）。
 *
 * 导航行仍然由各功能自己贡献（`placement: 'nav'` 的 sidebarSections），外壳一个产品
 * 常量都不写：legacy 的 `SURFACE_NAVIGATION_ORDER` 是那个包认识全部功能才有的
 * 产品常量，新架构里换成贡献点（03 页 §4、06 页 §6）。
 *
 * 默认（缺省 placement）的条目落在中部面板那一格 —— 那是线程列表，可滚动。
 *
 * 底部行（帮助菜单 + 设置）是外壳家具，留在外壳里（legacy sidebar-footer.tsx 同此）。
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

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
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
