import type { SkillDocumentPort } from '@poietica/feature-conversation/ui-api'
import { SkillDocumentToken } from '@poietica/feature-conversation/ui-api'
import { platformContract } from '@poietica/feature-platform/contract'
import type { TypedRpcClient } from '@poietica/rpc'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import type {
  MarketplaceEntry,
  McpCatalogEntry,
  McpServerInfo,
  McpStatus,
  PluginInfo,
  SkillInfo,
  SkillInstallSource,
} from '../contract'
import { extensionsContract } from '../contract'

export function createExtensionsApi(ctx: UiFeatureContext) {
  const rpc: TypedRpcClient<typeof extensionsContract> = ctx.rpc(extensionsContract)
  /* 两个跨功能的取用口落在这里：platform 的 dialog.pickFolder / dialog.pickFiles（技能页的两个安装入口）；conversation 的
   * SkillDocumentToken（「查看 SKILL.md」落到右坞那一格）。两边的 dependsOn 都写在 index.tsx 的 defineUiFeature 上。 */
  const platform = ctx.rpc(platformContract)
  const skillDocuments = ctx.services.get(SkillDocumentToken) as SkillDocumentPort
  return {
    platform: () => platform,
    openSkillDocument: (document: Parameters<SkillDocumentPort['open']>[0]): void => {
      skillDocuments.open(document)
    },
    skills: {
      list: (workspaceId: string | null): Promise<readonly SkillInfo[]> =>
        rpc.call('skills.list', workspaceId === null ? {} : { workspaceId }).then((r) => r.skills),
      setEnabled: (id: string, enabled: boolean): Promise<void> =>
        rpc.call('skills.setEnabled', { skillId: id, enabled }).then(() => undefined),
      install: (source: SkillInstallSource): Promise<SkillInfo> =>
        rpc.call('skills.install', { source }).then((r) => r),
      remove: (id: string): Promise<void> => rpc.call('skills.remove', { skillId: id }).then(() => undefined),
      read: (id: string): Promise<string> =>
        rpc.call('skills.read', { skillId: id }).then((r: { markdown: string }) => r.markdown),
      onChanged: (listener: () => void) => rpc.on('skills.changed', listener),
    },
    mcp: {
      list: (): Promise<readonly McpServerInfo[]> =>
        rpc.call('mcp.list', {}).then((r: { servers: McpServerInfo[] }) => r.servers),
      upsert: (server: McpServerInfo): Promise<void> => rpc.call('mcp.upsert', server).then(() => undefined),
      remove: (name: string): Promise<void> => rpc.call('mcp.remove', { name }).then(() => undefined),
      status: (): Promise<readonly McpStatus[]> => rpc.call('mcp.status', {}).then((r) => r.servers),
      catalog: (query: string): Promise<readonly McpCatalogEntry[]> =>
        rpc.call('mcp.catalog', { query }).then((r) => r.entries),
      onStatusChanged: (listener: (statuses: readonly McpStatus[]) => void) =>
        rpc.on('mcp.statusChanged', (p) => listener(p.servers)),
    },
    plugins: {
      list: (): Promise<readonly PluginInfo[]> =>
        rpc.call('plugins.list', {}).then((r: { plugins: PluginInfo[] }) => r.plugins),
      marketplace: (query: string | null): Promise<readonly MarketplaceEntry[]> =>
        rpc.call('plugins.marketplace', { query }).then((r: { entries: MarketplaceEntry[] }) => r.entries),
      install: (id: string): Promise<PluginInfo> => rpc.call('plugins.install', { pluginId: id }).then((r) => r),
      uninstall: (id: string): Promise<void> => rpc.call('plugins.uninstall', { pluginId: id }).then(() => undefined),
      setEnabled: (id: string, enabled: boolean): Promise<void> =>
        rpc.call('plugins.setEnabled', { pluginId: id, enabled }).then(() => undefined),
      onChanged: (listener: () => void) => rpc.on('plugins.changed', listener),
    },
  }
}

export type ExtensionsApi = ReturnType<typeof createExtensionsApi>
