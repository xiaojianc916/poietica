/* 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。 */
export type {
  RegisteredCommand,
  UICommand,
  UICommandHandler,
} from './command-contract'
export { type CommandRegistry, createCommandRegistry } from './command-registry'
export {
  CommandPalette,
  type CommandPaletteProps,
} from './commands/command-palette'
export {
  CommandProvider,
  type CommandProviderProps,
  useCommands,
} from './commands/command-provider'
export { formatKeybinding, useCommandKeybindings } from './commands/keybinding'
export type {
  WorkspacePart,
  WorkspacePartId,
  WorkspaceParts,
} from './parts'
export {
  SidebarFooter,
  type SidebarFooterProps,
} from './shell/sidebar/sidebar-footer'
export { WorkspaceSidebar } from './shell/sidebar/workspace-sidebar'
export { useCanDockSidebar, useIsSidebarDocked } from './shell/sidebar-docking'
export {
  SurfaceHost,
  type SurfaceHostProps,
} from './shell/surface-host'
export {
  WorkbenchTabs,
  type WorkbenchTabsProps,
} from './shell/workbench-tabs/workbench-tabs'
export { WORKSPACE_LAYOUT } from './shell/workspace-layout'
export { useWorkspaceLayoutState, workspaceLayoutStore } from './shell/workspace-layout-store'
export { WorkspaceShell } from './shell/workspace-shell'
export type { WorkspaceShellActions, WorkspaceShellProps } from './shell-contract'
export type { SurfaceRenderers } from './surface'
export {
  CONVERSATION_ENTRY_TITLE,
  DEFAULT_SURFACE_ID,
  describeSurface,
  isSurfaceId,
  SURFACE_NAVIGATION_ORDER,
  SURFACE_REGISTRY,
  type SurfaceDescriptor,
  type SurfaceId,
} from './surface-registry'
export {
  type ActiveConversationViewModel,
  type ConversationId,
  type ConversationTabViewModel,
  DEFAULT_SURFACE_TAB_ID,
  type OpenConversationRequest,
  type OpenSurfaceRequest,
  type SurfaceTabViewModel,
  type SurfaceViewModel,
  type WorkbenchSessionCommands,
  type WorkbenchSessionStore,
  type WorkbenchSurfaceViewModel,
  type WorkbenchTabId,
  type WorkbenchTabViewModel,
  type WorkbenchViewModel,
} from './workbench'
export {
  createWorkbenchSessionController,
  type WorkbenchSessionOptions,
} from './workbench-session-controller'
