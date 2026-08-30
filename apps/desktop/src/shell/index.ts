/*
 * 外壳视图的组合出口：区域组装、停靠视图与布局持久化都在组合根
 * （对齐目标树 A.2 的 src/shell/）。领域逻辑住在 @poietica/workspace。
 */

export { CommandPalette } from './commands/command-palette'
export { formatKeybinding, useCommandKeybindings } from './commands/keybinding'
export { SidebarFooter } from './sidebar/sidebar-footer'
export { WorkspaceSidebar } from './sidebar/workspace-sidebar'
export { SurfaceHost } from './surface-host'
export { WorkbenchTabs } from './workbench-tabs'
export { useWorkspaceLayoutState, workspaceLayoutStore } from './workspace-layout-store'
export { WorkspaceShell } from './workspace-shell'
