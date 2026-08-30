import type { SurfaceId, WorkbenchTabId, WorkbenchViewModel } from '@poietica/workspace'
import type { WorkspaceParts } from './parts'

export type { WorkspaceParts }

/**
 * 工作台的动作表。
 *
 * 它属于组合根：接线的是组合根，外壳只摆放已经接好线的 Part。此前它同时是
 * WorkspaceShellProps 的一个字段，而外壳一次都没有读过它 —— 传进去只是让人
 * 以为外壳会用。命令面板那一格也随之去掉：全仓找不到任何一处读它，那个界面
 * 的入口是快捷键与命令注册表。
 */
export interface WorkspaceShellActions {
  readonly activateTab: (tabId: WorkbenchTabId) => void
  readonly closeTab: (tabId: WorkbenchTabId) => void
  readonly moveTab: (tabId: WorkbenchTabId, targetIndex: number) => void
  /** 只收 id，标题由 registry 查。 */
  readonly openSurface: (surfaceId: SurfaceId) => void
  readonly openDeveloperTools: () => void
  readonly openSettingsWindow: () => void
}

/**
 * 工作台外壳的输入。
 *
 * 只有两样东西：一份投影、一张 Part 表。此前这里有五个 ReactNode 通道
 * 加一个渲染回调 —— 每加一个区域就多一个 prop，布局职责被推给组合根做
 * props drilling。
 */
export interface WorkspaceShellProps {
  readonly model: WorkbenchViewModel
  readonly parts: WorkspaceParts
}
