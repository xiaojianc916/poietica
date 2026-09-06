import { describeSurface, isReadySurfaceId, type SurfaceId } from '@poietica/workspace'
import type { SurfaceRenderers } from './surface'
import { surfaceIcon } from './surface-icons'

export interface SurfaceHostProps {
  readonly surfaceId: SurfaceId

  readonly renderers: SurfaceRenderers
}

export function SurfaceHost({ surfaceId, renderers }: SurfaceHostProps) {
  if (isReadySurfaceId(surfaceId)) {
    return <>{renderers[surfaceId]()}</>
  }

  return <PlannedSurface surfaceId={surfaceId} />
}

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
