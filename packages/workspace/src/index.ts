/*
 * 工作台领域的唯一出口：会话控制器、命令注册表、表面注册表、标签模型与布局
 * 数学 —— 全是纯逻辑，没有 React（外壳与停靠视图住在 apps/desktop/src/shell）。
 */

export type { RegisteredCommand } from './command-contract'
export { type CommandRegistry, createCommandRegistry } from './command-registry'
export {
  DEFAULT_SURFACE_ID,
  describeSurface,
  isReadySurfaceId,
  isSurfaceId,
  type ReadySurfaceId,
  SURFACE_NAVIGATION_ORDER,
  SURFACE_REGISTRY,
  type SurfaceActivation,
  type SurfaceDescriptor,
  type SurfaceIconId,
  type SurfaceId,
} from './surface-registry'
export type {
  ConversationId,
  OpenConversationRequest,
  OpenSurfaceRequest,
  WorkbenchSessionStore,
  WorkbenchSurfaceViewModel,
  WorkbenchTabId,
  WorkbenchTabViewModel,
  WorkbenchViewModel,
} from './workbench'
export { createWorkbenchSessionController } from './workbench-session-controller'
export type {
  WorkbenchTabDragLayout,
  WorkbenchTabKeyboardAction,
  WorkbenchTabModelItem,
  WorkbenchTabSlot,
} from './workbench-tabs-model'
export {
  encodeWorkbenchTabDomId,
  resolveWorkbenchTabAutoScrollVelocity,
  resolveWorkbenchTabCloseTarget,
  resolveWorkbenchTabDragLayout,
  resolveWorkbenchTabKeyboardAction,
} from './workbench-tabs-model'
export { type AuxiliaryMode, resolveAuxiliaryMode, WORKSPACE_LAYOUT } from './workspace-layout'
