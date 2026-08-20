import { type InstalledPlugin, resolutionOrder } from './installation'
import type { DeclaredMcpServer } from './mcp-config'
import type { BuiltinOrigin, ContributionOrigin } from './origin'

/*
 * 屏幕上那张 MCP 服务器列表。
 *
 * 装载不在这里发生，也不在本应用里发生。官方 plugins 文档写明插件声明的服务器由运行时
 * 按 installed.json 的 capabilities.mcpServers.<名字>.enabled 自己装载，用户级那份
 * mcp.json 同理由 CLI 读。此前这一层把它们解成 ACP 对象、再由客户端塞进 session/new，
 * 于是同一台服务器被起两次；而这一层解出来的那份还漏了 cwd —— 官方 kimi-datasource 写的
 * 是 { "command": "node", "args": ["./bin/kimi-datasource.mjs"], "cwd": "./" }，少了 cwd
 * 那条相对路径必然找不到文件。该谁起谁起，本应用只投影。
 *
 * 内置那一台由本应用自己的进程起着，端口由内核分配；但没有任何一条路把它挂进会话 ——
 * kap 的 session/new 不收名册。列出来时如实说这一点。
 *
 * 关掉的照样列出来。拨到关就消失、再也开不回来，那不是开关，是删除。
 */

/**
 * 谁在起它。client 是本应用自己的进程（内置那一台，端口绑上才算），agent 是命令行
 * 按配置起。none 是没有人起，不是起不来。client 不等于「挂进了会话」——
 * kap 的 session/new 不收名册，那条路今天不存在。
 */
export type McpServerLaunchedBy = 'agent' | 'client' | 'none'

export interface ResolvedMcpServer {
  readonly origin: ContributionOrigin
  readonly name: string
  /** 这一台自己的开关。界面上那个 Switch 显示的就是它。 */
  readonly enabled: boolean
  readonly launchedBy: McpServerLaunchedBy
}

/**
 * 本应用自己在进程里起的那一台。
 *
 * 地址由原生侧在启动时绑定并登记，这一层只是收下 —— 端口是内核分配的，谁都不需要事先
 * 约定一个数字。绑不上时 url 缺席：那一行仍然要显示，人才知道它为什么没起来，而不是
 * 以为自己没装。
 */
export interface BuiltinMcpServer {
  readonly name: string
  readonly url: string | undefined
  /** 人在界面上拨的那个开关。 */
  readonly enabled: boolean
}

export interface McpServerInput {
  readonly plugins: readonly InstalledPlugin[]
  /** 这个 agent 自己那份 mcp.json 里已经配好的那些。受控 home 生效时由本应用增删与启停。 */
  readonly environment: readonly DeclaredMcpServer[]
  /** 本应用自己起的那些。 */
  readonly builtin: readonly BuiltinMcpServer[]
}

const BUILTIN_ORIGIN: BuiltinOrigin = { kind: 'builtin' }

/* 自带的排最前，机器上那些次之：它们都先于任何插件存在，界面上也是这个次序。 */
export function resolveMcpServers(input: McpServerInput): readonly ResolvedMcpServer[] {
  const resolved: ResolvedMcpServer[] = []

  for (const server of input.builtin) {
    resolved.push({
      origin: BUILTIN_ORIGIN,
      name: server.name,
      enabled: server.enabled,
      launchedBy: server.enabled && server.url !== undefined ? 'client' : 'none',
    })
  }

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
