import { describeSurface, type SurfaceIconId, type SurfaceId } from '@poietica/workspace'
import { AlarmClock, SquarePen } from 'lucide-react'
import type { ComponentType } from 'react'

export type SurfaceIcon = ComponentType<{
  readonly className?: string
  readonly 'aria-hidden'?: boolean | 'true' | 'false'
}>

const SURFACE_ICONS: Record<SurfaceIconId, SurfaceIcon> = {
  clock: AlarmClock,
  message: SquarePen,
}

export function surfaceIcon(id: SurfaceId): SurfaceIcon {
  return SURFACE_ICONS[describeSurface(id).iconId]
}
