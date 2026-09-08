import { describeSurface, type SurfaceIconId, type SurfaceId } from '@poietica/workspace'
import { AlarmClock, BookOpen, HatGlasses, Search, SquarePen } from 'lucide-react'
import type { ComponentType } from 'react'

export type SurfaceIcon = ComponentType<{
  readonly className?: string
  readonly 'aria-hidden'?: boolean | 'true' | 'false'
}>

const SURFACE_ICONS: Record<SurfaceIconId, SurfaceIcon> = {
  'book-open': BookOpen,
  clock: AlarmClock,
  message: SquarePen,
  search: Search,
  'hat-glasses': HatGlasses,
}

export function surfaceIcon(id: SurfaceId): SurfaceIcon {
  return SURFACE_ICONS[describeSurface(id).iconId]
}
