import type { SurfaceId, WorkbenchTabId, WorkbenchViewModel } from '@poietica/workspace'
import type { WorkspaceParts } from './parts'

export type { WorkspaceParts }

export interface WorkspaceShellActions {
  readonly activateTab: (tabId: WorkbenchTabId) => void
  readonly closeTab: (tabId: WorkbenchTabId) => void
  readonly moveTab: (tabId: WorkbenchTabId, targetIndex: number) => void
  /** 只收 id，标题由 registry 查。 */
  readonly openSurface: (surfaceId: SurfaceId) => void
  readonly openDeveloperTools: () => void
  readonly openSettingsWindow: () => void
}

export interface WorkspaceShellProps {
  readonly model: WorkbenchViewModel
  readonly parts: WorkspaceParts
}
