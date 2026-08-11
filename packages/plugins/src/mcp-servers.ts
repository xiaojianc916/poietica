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
 * 唯一由本应用亲手送进会话的是内置那一台：它不在任何配置文件里，进程起来它才存在，
 * 端口由内核分配，所以只有本应用说得出它的地址。
 *
 * 关掉的照样列出来。拨到关就消失、再也开不回来，那不是开关，是删除。
 */

/**
 * ACP 认得的那个对象。
 *
 * 只有 http 这一支。判别式由协议钉死（schema 那一侧是
 * #[serde(tag = "type", rename_all = "snake_case")]），而本应用送得出去的只有内置那一台
 * 本机 http 端点。子进程那一支不在这里出现 —— 起子进程的是 CLI，形状也归它。
 *
 * 写成类型别名而不是 interface，是因为桥那一层把它当不透明 JSON 送过去（原生侧只能把
 * ACP 的结构体反序列化出来，它们全是 #[non_exhaustive]，构造不出来），而 TypeScript 只
 * 给对象类型别名隐式索引签名，不给 interface —— interface 可以在别处被声明合并追加字段，
 * 属性集合不封闭。改回 interface 会当场编译不过；加索引签名或强转都是把约束扔掉换编译过。
 */
export type McpServerWire = {
  readonly type: 'http'
  readonly name: string
  readonly url: string
}

/** 这一次谁会起它。none 是「这一次没有人会起它」，不是「起不来」。 */
export type McpServerLaunchedBy = 'agent' | 'client' | 'none'

export interface ResolvedMcpServer {
  readonly origin: ContributionOrigin
  readonly name: string
  /** 这一台自己的开关。界面上那个 Switch 显示的就是它。 */
  readonly enabled: boolean
  readonly launchedBy: McpServerLaunchedBy
  /** 本应用亲手送进会话的那一台才有形状。其余的我们不构造。 */
  readonly wire: McpServerWire | undefined
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
    const wire: McpServerWire | undefined =
      server.url === undefined ? undefined : { type: 'http', name: server.name, url: server.url }

    resolved.push({
      origin: BUILTIN_ORIGIN,
      name: server.name,
      enabled: server.enabled,
      launchedBy: server.enabled && wire !== undefined ? 'client' : 'none',
      wire,
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
      wire: undefined,
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
        wire: undefined,
      })
    }
  }

  return resolved
}
