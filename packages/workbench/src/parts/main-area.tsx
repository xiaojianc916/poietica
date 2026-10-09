import { builtinPoints, FeatureScope, useContributions, useNavigation } from '@poietica/ui-kernel'
import { type ReactNode, Suspense } from 'react'
import { PartSkeleton } from './part-skeleton'
import { UnknownSurface } from './unknown-surface'

/**
 * 表面宿主。**迁移自** legacy `shell/surfaces/surface-host.tsx`：已注册的表面渲染自身，
 * 未注册的落到 PlannedSurface 占位（legacy 对未实现表面的处理方式同此）。
 *
 * 区域内容来自 surfaces 贡献点 —— legacy 的 SurfaceRenderers 注册表在这里就是它。
 */
export function MainArea(): ReactNode {
  const { route } = useNavigation()
  const surfaces = useContributions(builtinPoints.surfaces)
  const found = surfaces.find((c) => c.item.id === route.surface)
  if (found === undefined) return <UnknownSurface surface={route.surface} />
  const Component = found.item.component
  return (
    <main aria-label={found.item.title} className="workbench__main" data-workbench-part="main">
      {/* key 让切换线程（params 变化）时组件重新挂载 */}
      <FeatureScope featureId={found.featureId} key={route.surface + JSON.stringify(route.params)}>
        <Suspense fallback={<PartSkeleton />}>
          <Component params={route.params} />
        </Suspense>
      </FeatureScope>
    </main>
  )
}
