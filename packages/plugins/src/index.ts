/*
 * 包的公开面。逐个具名导出，不用 export *：对外承诺了什么，读这一份文件就够。
 *
 * fetch-plan 与 marketplace 的内部结构不在这里露头 —— 取用计划怎么拼、目录怎么解，
 * 是这个包自己的事，外面只需要「装了什么、市场上有什么、界面长什么样」。
 */

export {
  BUILTIN_SERVERS,
  type BuiltinServer,
  type BuiltinTransport,
  type HttpTransport,
  mcpServerBody,
  type StdioTransport,
} from './catalog/builtin'
export {
  builtinServerRows,
  type CatalogRow,
  groupRows,
  type ListingStatus,
  matches,
  type PluginListingInput,
  publicPluginRows,
  type RowGroup,
  statusText,
} from './catalog/listing'
export {
  CATALOG_CHANNELS,
  type CatalogChannel,
  describeChannel,
  type ExtensionScope,
  scopeOf,
  survivesUninstall,
} from './catalog/scope'
export {
  type ArchiveSource,
  type CommitRef,
  type DefaultBranchRef,
  type DirectorySource,
  describeInstallSource,
  type GitHubRef,
  type GitHubSource,
  PLUGIN_TRUST_TIERS,
  type PluginInstallSource,
  type PluginTrustTier,
  parseInstallSource,
  type ReleaseTagRef,
  requiresInstallConfirmation,
  type TreeRef,
  UNLISTED_TRUST,
} from './install-source'
export { type InstalledPlugin, resolutionOrder } from './installation'
export {
  type AcceptedManifest,
  DEFAULT_AGENT_ROOT,
  DEFAULT_SKILL_ROOT,
  decodePluginManifest,
  type FilePromptSource,
  type InlinePromptSource,
  type ManifestDecoding,
  PLUGIN_MANIFEST_FILENAMES,
  type PluginDiagnostic,
  type PluginDiagnosticCode,
  type PluginManifest,
  type PluginPromptSource,
  type RejectedManifest,
  UNSUPPORTED_MANIFEST_FIELDS,
} from './manifest'
export type {
  MarketplaceCatalog,
  MarketplaceEntry,
  MarketplaceState,
} from './marketplace'
export {
  type DeclaredMcpServer,
  decodeMcpConfig,
  type McpConfigDecoding,
} from './mcp-config'
export {
  type BuiltinMcpServer,
  type McpServerInput,
  type McpServerLaunchedBy,
  type McpServerWire,
  type ResolvedMcpServer,
  resolveMcpServers,
} from './mcp-servers'
export {
  type BuiltinOrigin,
  type ContributionOrigin,
  describeOrigin,
  type ManagedOrigin,
  type PluginOrigin,
  type UserOrigin,
} from './origin'
export {
  createPluginStore,
  type ForeignPlugin,
  type IdleInstall,
  INSTALL_IDLE,
  type InstallFlow,
  type PluginStore,
  type PluginStoreOptions,
  type PluginsViewModel,
  type RefusedInstall,
  type StagedInstall,
  type StagingInstall,
} from './plugin-store'
export {
  createSnapshotCache,
  EMPTY_SNAPSHOT,
  type ExtensionSnapshot,
  type SnapshotCache,
  type SnapshotCacheOptions,
} from './registry/snapshot'
export { PluginsSurface, type PluginsSurfaceProps } from './surface/plugins-surface'
