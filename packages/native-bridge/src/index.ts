/* 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。 */

export type { Problem } from '@poietica/problem'
export { throughIpc } from './error'
export {
  type AgentBridgeOptions,
  createAgentCapabilityBridge,
  createAgentSessionConfigBridge,
  createAgentSessionPort,
  createAgentSessionUsageBridge,
  createAgentThreadBridge,
  createAgentToolkitReader,
  shutdownAgent,
} from './gateways/agent'
export {
  type AgentConfigSnapshot,
  createAgentConfigBridge,
} from './gateways/agent-config'
export { createAgentConfigStore } from './gateways/agent-config-store'
export {
  type AssetFormat,
  importAssets,
  listAssetFormats,
  openAssetSession,
  removeAsset,
  uploadAsset,
} from './gateways/asset'
export { automationGateway } from './gateways/automations'
export {
  type BrowserElementPicked,
  type BrowserState,
  type BrowserTab,
  type BrowserViewportBounds,
  browserDevtoolsEndpoint,
  browserHostPort,
  browserTabBack,
  browserTabForward,
  browserTabReload,
  closeBrowserTab,
  navigateBrowserTab,
  openBrowserTab,
  openBrowserUrlExternally,
  printBrowserTab,
  reopenClosedBrowserTab,
  selectBrowserTab,
  setBrowserElementPicker,
  setBrowserViewportBounds,
  setBrowserVisible,
  watchBrowserElementPicked,
  watchBrowserState,
} from './gateways/browser'
export {
  type CustomAgentCatalog,
  type CustomAgentFile,
  type CustomAgentRemoveRequest,
  type CustomAgentSaveRequest,
  listCustomAgents,
  removeCustomAgent,
  saveCustomAgent,
} from './gateways/custom-agents'
export { capabilityGateway, extensionGateway } from './gateways/extension'
export {
  type GitBranches,
  type GitCommitIntent,
  type GitCommitRequest,
  type GitFileChange,
  type GitReview,
  gitBranches,
  gitCreateBranch,
  gitSwitchBranch,
  reviewGateway,
} from './gateways/git'
export { resolveLauncher } from './gateways/launcher'
export { readMcpEndpoint } from './gateways/mcp'
export { createSettingsStore } from './gateways/settings'
export { terminalHostPort } from './gateways/terminal'
export { appUpdateController } from './gateways/update'
export { readTokenDays } from './gateways/usage'
export { readWorkbenchSession, writeWorkbenchSession } from './gateways/workbench'
export {
  createProjectlessWorkspace,
  pickWorkspaceRoot,
} from './gateways/workspace'
export { readAppVersion } from './platform/app-release'
export { readDataDirectory } from './platform/data-directory'
export { type FilePickerFilter, pickPaths, watchDroppedPaths } from './platform/dialog'
export {
  type NativeCrashReport,
  takePreviousNativeCrashReport,
} from './platform/native-crash-report'
export {
  createMainWindowController,
  type MainWindowController,
} from './platform/native-window'
export { basename, homeDirectory } from './platform/paths'
