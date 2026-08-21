import { type InstalledPlugin, resolutionOrder } from './installation'
import type { DeclaredMcpServer } from './mcp-config'
import type { ContributionOrigin } from './origin'

/*
 * 屏幕上那张 MCP 服务器列表。
 *
 * 装载不在这里发生，也不在本应用里发生。官方 plugins 文档写明插件声明的服务器由运行时
 * 按 installed.json 的 capabilities.mcpServers.<名字>.enabled 自己装载，mcp.json 那份
 * 同理由 CLI 读；官方 kimi-datasource 的条目是
 * { "command": "node", "args": ["./bin/kimi-datasource.mjs"], "cwd": "./" }，少了 cwd
 * 那条相对路径必然找不到文件。
 *
 * 本应用托管的那几台（自动化、浏览器）也写进同一份 mcp.json，所以「谁来起它」全表只有
 * 一个答案。kap 的 session/new 不收名册，本应用没有第二条路把服务器塞进会话。
 *
 * 关掉的照样列出来。拨到关就消失、再也开不回来，那不是开关，是删除。
 */

/** agent 是命令行按 mcp.json 起。none 是没有人起，不是起不来。 */
export type McpServerLaunchedBy = 'agent' | 'none'

export interface ResolvedMcpServer {
  readonly origin: ContributionOrigin
  readonly name: string
  /** 这一台自己的开关。界面上那个 Switch 显示的就是它。 */
  readonly enabled: boolean
  readonly launchedBy: McpServerLaunchedBy
}

export interface McpServerInput {
  readonly plugins: readonly InstalledPlugin[]
  /** 这个 agent 自己那份 mcp.json 里已经配好的那些。受控 home 生效时由本应用增删与启停。 */
  readonly environment: readonly DeclaredMcpServer[]
}

/* mcp.json 里那些排在前：它们先于任何插件存在，界面上也是这个次序。 */
export function resolveMcpServers(input: McpServerInput): readonly ResolvedMcpServer[] {
  const resolved: ResolvedMcpServer[] = []

  /*
   * 配置文件里那个 enabled 决定 CLI 装不装它。缺席即开着（官方 MCP 文档：Set to false
   * to disable this server），所以这里读到的假就是人自己写的假。
   */
  for (const server of input.environment) {
    resolved.push({
      origin: server.origin,
      name: server.name,
      enabled: server.enabledInConfig,
      launchedBy: server.enabledInConfig ? 'agent' : 'none',
    })
  }

  for (const plugin of resolutionOrder(input.plugins)) {
    const origin: ContributionOrigin = { kind: 'plugin', pluginId: plugin.pluginId }
    const disabled = new Set(plugin.disabledMcpServers)

    for (const name of plugin.manifest.mcpServerNames) {
      const enabled = !disabled.has(name)

      resolved.push({
        origin,
        name,
        enabled,
        launchedBy: plugin.enabled && enabled ? 'agent' : 'none',
      })
    }
  }

  return resolved
}
