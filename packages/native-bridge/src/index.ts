/* 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。 */

export type { Problem } from '@poietica/problem'
export {
  type AgentBridgeOptions,
  createAgentCapabilityBridge,
  createAgentSessionConfigBridge,
  createAgentSessionPort,
  createAgentSessionUsageBridge,
  createAgentThreadBridge,
  createAgentToolkitReader,
  shutdownAgent,
} from './agent'
export {
  type AgentConfigSnapshot,
  createAgentConfigBridge,
} from './agent-config'
export { readAppVersion } from './app-release'
export {
  type AssetFormat,
  importAssets,
  listAssetFormats,
  openAssetSession,
  removeAsset,
  uploadAsset,
} from './asset'
export {
  type Automation,
  type AutomationCatalog,
  type AutomationReschedule,
  type AutomationRun,
  createAutomation,
  loadAutomations,
  recordAutomationRun,
  removeAutomation,
  upsertAutomation,
  watchAutomationCatalog,
  watchAutomations,
} from './automations'
export {
  type BrowserElementPicked,
  type BrowserState,
  type BrowserTab,
  type BrowserViewportBounds,
  browserDevtoolsEndpoint,
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
} from './browser'
export {
  type CustomAgentCatalog,
  type CustomAgentFile,
  type CustomAgentRemoveRequest,
  type CustomAgentSaveRequest,
  listCustomAgents,
  removeCustomAgent,
  saveCustomAgent,
} from './custom-agents'
export { readDataDirectory } from './data-directory'
export {
  readEnvironmentMcpConfig,
  writeEnvironmentMcpConfig,
} from './environment'
export { throughIpc } from './error'
export {
  type GitBranches,
  type GitCommitIntent,
  type GitCommitRequest,
  type GitFileChange,
  type GitReview,
  gitAwaitChange,
  gitBranches,
  gitCommit,
  gitCreateBranch,
  gitFilePatch,
  gitReview,
  gitSwitchBranch,
} from './git'
export { resolveLauncher } from './launcher'
export { readMcpEndpoint } from './mcp'
export {
  type NativeCrashReport,
  takePreviousNativeCrashReport,
} from './native-crash-report'
export {
  createMainWindowController,
  type MainWindowController,
} from './native-window'
export {
  commitPlugin,
  discardStagedPlugin,
  listForeignPlugins,
  listPlugins,
  readPluginCatalog,
  refreshPluginCatalog,
  removePlugin,
  setPluginEnabled,
  setPluginMcpEnabled,
  stagePlugin,
} from './plugins'
export {
  commitSkill,
  discardStagedSkill,
  listSkills,
  removeSkill,
  type SkillRecord,
  setSkillEnabled,
  stageSkill,
} from './skills'
export { readTokenDays } from './usage'
export { readWorkbenchSession, writeWorkbenchSession } from './workbench'
export {
  createProjectlessWorkspace,
  pickWorkspaceRoot,
} from './workspace'
