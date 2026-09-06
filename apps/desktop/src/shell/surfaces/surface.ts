import type { ReadySurfaceId } from '@poietica/workspace'
import type { ReactNode } from 'react'

export type SurfaceRenderers = Record<ReadySurfaceId, () => ReactNode>
