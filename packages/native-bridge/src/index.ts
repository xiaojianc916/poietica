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
export {
  type AssetFormat,
  importAssets,
  listAssetFormats,
  openAssetSession,
  removeAsset,
  uploadAsset,
} from './gateways/asset'
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
} from './gateways/automations'
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
export {
  readEnvironmentMcpConfig,
  writeEnvironmentMcpConfig,
} from './gateways/environment'
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
} from './gateways/git'
export { resolveLauncher } from './gateways/launcher'
export { readMcpEndpoint } from './gateways/mcp'
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
} from './gateways/plugins'
export {
  commitSkill,
  discardStagedSkill,
  listSkills,
  removeSkill,
  type SkillRecord,
  setSkillEnabled,
  stageSkill,
} from './gateways/skills'
export { readTokenDays } from './gateways/usage'
export { readWorkbenchSession, writeWorkbenchSession } from './gateways/workbench'
export {
  createProjectlessWorkspace,
  pickWorkspaceRoot,
} from './gateways/workspace'
export { readAppVersion } from './platform/app-release'
export { readDataDirectory } from './platform/data-directory'
export {
  type NativeCrashReport,
  takePreviousNativeCrashReport,
} from './platform/native-crash-report'
export {
  createMainWindowController,
  type MainWindowController,
} from './platform/native-window'
