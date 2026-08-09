import type { SurfaceRenderers } from '../surface'
import { describeSurface, isReadySurfaceId, type SurfaceId } from '../surface-registry'
import { surfaceIcon } from './surface-icons'

export interface SurfaceHostProps {
  readonly surfaceId: SurfaceId

  /**
   * 由 apps 组合根注入的表面渲染器。
   *
   * workspace 不得依赖任何 feature 包；具体表面通过此扩展点接入。
   */
  readonly renderers: SurfaceRenderers
}

/**
 * 表面渲染的唯一出口。
 *
 * 两条分支，都是有意的：
 *
 *   - ready 的表面必然有渲染器（renderers 是以 ReadySurfaceId 为键的
 *     全域 Record），「查不到」在类型上不成立，因此没有 ?? 兜底；
 *   - 其余的走下面那张明说「还没实现」的页面。命令行（activation.kind 为
 *     'command'）正常路径到不了这里 —— 点它执行命令，主区不动；只有上次会话
 *     留下的旧标签能落到这一支，那时这张页面就是最诚实的说法。
 */
export function SurfaceHost({ surfaceId, renderers }: SurfaceHostProps) {
  if (isReadySurfaceId(surfaceId)) {
    return <>{renderers[surfaceId]()}</>
  }

  return <PlannedSurface surfaceId={surfaceId} />
}

/**
 * 还没实现的表面。
 *
 * 关键是那句「这个表面还没有实现」：一张只有图标和标题的空页面，人读到的是
 * 「坏了」；写明了，人读到的才是「排在后面」。文案与图标都取自注册表，这一层
 * 一个字面量都不新造。
 */
function PlannedSurface({ surfaceId }: { readonly surfaceId: SurfaceId }) {
  const descriptor = describeSurface(surfaceId)
  const Icon = surfaceIcon(surfaceId)
  const titleId = `surface-title-${surfaceId}`

  return (
    <section
      aria-labelledby={titleId}
      className="grid h-full place-items-center bg-ground px-8 text-center"
    >
      <div>
        <div className="mx-auto grid size-12 place-items-center rounded-xl border border-divider bg-background shadow-sm">
          <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
        </div>

        <h1 className="mt-4 text-base font-semibold tracking-tight" id={titleId}>
          {descriptor.title}
        </h1>

        <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">
          {descriptor.description}
        </p>

        <p className="mt-3 text-xs text-muted-foreground">这个表面还没有实现。</p>
      </div>
    </section>
  )
}
