import type { SurfaceId, WorkbenchTabId } from '@poietica/workspace'
import type { WorkspaceParts } from './parts'

export type { WorkspaceParts }

/** 外壳转交给顶栏的动作。只列实际被消费的：空着的成员是没人兑现的承诺。 */
export interface WorkspaceShellActions {
  readonly activateTab: (tabId: WorkbenchTabId) => void
  /** 只收 id，标题由 registry 查。 */
  readonly openSurface: (surfaceId: SurfaceId) => void
}

export interface WorkspaceShellProps {
  readonly parts: WorkspaceParts
}
