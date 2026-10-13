import { builtinPoints, FeatureScope, useContributions, useNavigation } from '@poietica/ui-kernel'
import { type ReactNode, Suspense } from 'react'
import { PartSkeleton } from './part-skeleton'
import { UnknownSurface } from './unknown-surface'

/** 表面宿主：已注册的表面渲染自身，未注册的落到 UnknownSurface 占位。 */
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
