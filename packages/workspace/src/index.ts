/* 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。 */
export { type CommandRegistry, createCommandRegistry } from './command-registry'
export {
  CommandPalette,
  type CommandPaletteProps,
} from './commands/command-palette'
export { formatKeybinding, useCommandKeybindings } from './commands/keybinding'
export type { WorkspaceParts } from './parts'
export { SidebarFooter } from './shell/sidebar/sidebar-footer'
export { WorkspaceSidebar } from './shell/sidebar/workspace-sidebar'
export { SurfaceHost } from './shell/surface-host'
export { WorkbenchTabs } from './shell/workbench-tabs/workbench-tabs'
export { useWorkspaceLayoutState, workspaceLayoutStore } from './shell/workspace-layout-store'
export { WorkspaceShell } from './shell/workspace-shell'
export type { WorkspaceShellActions } from './shell-contract'
export type { SurfaceRenderers } from './surface'
export { DEFAULT_SURFACE_ID } from './surface-registry'
export type {
  WorkbenchSessionStore,
  WorkbenchTabId,
  WorkbenchTabViewModel,
} from './workbench'
export { createWorkbenchSessionController } from './workbench-session-controller'
