import type {
  ForeignPluginLedger,
  PluginCommitRequest,
  PluginFetch,
  PluginPayload,
  PluginStaged,
} from '@poietica/contract'
import { commands } from '@poietica/contract'
import { throughIpc } from '../error'

/*
 * DTO 一个字都不在这里重新声明：原生侧是契约的产地，这一层只把它转成 Promise 并让
 * 失败走同一条 throughIpc。手写一份对齐的类型就是两份真相。
 */
export type {
  ForeignPluginLedger,
  ForeignPluginRecord,
  PluginCommitRequest,
  PluginFetch,
  PluginPayload,
  PluginStaged,
} from '@poietica/contract'

export function listPlugins(): Promise<PluginPayload[]> {
  return throughIpc(() => commands.pluginsList())
}

export function stagePlugin(fetch: PluginFetch): Promise<PluginStaged> {
  return throughIpc(() => commands.pluginsStage(fetch))
}

export function commitPlugin(request: PluginCommitRequest): Promise<void> {
  return throughIpc(async () => {
    await commands.pluginsCommit(request)
  })
}

export function discardStagedPlugin(stagingId: string): Promise<void> {
  return throughIpc(async () => {
    await commands.pluginsDiscard(stagingId)
  })
}

export function removePlugin(pluginId: string): Promise<void> {
  return throughIpc(async () => {
    await commands.pluginsRemove(pluginId)
  })
}

export function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  return throughIpc(async () => {
    await commands.pluginsSetEnabled(pluginId, enabled)
  })
}

export function setPluginMcpEnabled(
  pluginId: string,
  server: string,
  enabled: boolean,
): Promise<void> {
  return throughIpc(async () => {
    await commands.pluginsSetMcpEnabled(pluginId, server, enabled)
  })
}

export function readPluginCatalog(): Promise<string | null> {
  return throughIpc(() => commands.pluginsCatalogRead())
}

export function refreshPluginCatalog(url: string): Promise<string> {
  return throughIpc(() => commands.pluginsCatalogRefresh(url))
}

/*
 * 用户自己那个家里的那本账 —— 只读。
 *
 * null 表示这台机器上没有第二本账：受控 home 没有生效时，CLI 与我们读的是同一个文件。
 * 空数组表示那本账在，里面一个插件都没有。两者要分得开，界面上一句话都不一样。
 */
export function listForeignPlugins(): Promise<ForeignPluginLedger | null> {
  return throughIpc(() => commands.pluginsForeignList())
}
