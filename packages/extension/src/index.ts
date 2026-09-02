/*
 * 包的公开面。逐个具名导出，不用 export *：对外承诺了什么，读这一份文件就够。
 *
 * fetch-plan 与 marketplace 的内部结构不在这里露头 —— 取用计划怎么拼、目录怎么解，
 * 是这个包自己的事，外面只需要「装了什么、市场上有什么、界面长什么样」。
 */

export {
  type CapabilityCommand,
  type CapabilityInventory,
  COMPUTER_USE,
  type ComputerUse,
  computerUse,
} from './capability'
export type { CapabilityGateway } from './capability-gateway'
export { BUILTIN_SERVERS, type Launcher, mcpServerBody } from './catalog/builtin'
export {
  builtinServerRows,
  builtinSkillRows,
  type CatalogRow,
  groupRows,
  matches,
  publicPluginRows,
  type RowGroup,
  statusText,
} from './catalog/listing'
export { describeChannel } from './catalog/scope'
export type { ExtensionGateway } from './extension-gateway'
export {
  describeInstallSource,
  type PluginInstallSource,
  type PluginTrustTier,
  parseInstallSource,
} from './install-source'
export type { InstalledPlugin } from './installation'
export { latestCatalog, type MarketplaceEntry } from './marketplace'
export type { ResolvedMcpServer } from './mcp-servers'
export { type ContributionOrigin, describeOrigin, type PluginOrigin } from './origin'
export {
  createPluginStore,
  type ForeignPlugin,
  type InstallFlow,
  type PluginStore,
  type PluginsViewModel,
} from './plugin-store'
export { type SkillRow, skillRows } from './skill'
