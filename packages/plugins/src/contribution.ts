import type { PluginCommand } from './command'
import { type InstalledPlugin, resolutionOrder } from './installation'
import { type PluginDiagnostic, SESSION_PROMPT_BUDGET_BYTES, utf8ByteLength } from './manifest'
import type { DeclaredMcpServer } from './mcp-config'
import { type McpServerWire, mcpServerWireOf } from './mcp-server'
import type { BuiltinOrigin, ContributionOrigin } from './origin'
import type { PluginSkill } from './skill'

/*
 * 一次遍历，两个读者。
 *
 * 管理界面要看见全部：关掉的插件、关掉的服务器都得留在列表里，否则拨到关就再也开不
 * 回来。会话要的是「真的会生效的那些」。所以这里一次产出全部，每一条带上自己的启用
 * 位，会话读 enabled / active 那一档。不是两条管线，是一份结果加一个显式过滤。
 *
 * 每一条都说得出自己从哪来。三种来源 —— 本应用自带的、这台机器上配好的、插件带来的
 * —— 是同一种东西，因此走同一个列表，而不是界面上另起几格自己去合并。
 *
 * 技能与命令进来时已经是实体（InstalledPlugin.registry），这一层只做跨插件仲裁：排
 * 序、带上启用位、把诊断汇总。它不读盘，也不认识 Markdown。
 */

export interface ResolvedSkill {
  readonly skill: PluginSkill
  /** 带来它的那个插件开着没有。关掉的照样列出来，否则开关就没有落脚点。 */
  readonly enabled: boolean
}

export interface ResolvedCommand {
  readonly command: PluginCommand
  readonly enabled: boolean
}

export interface ResolvedMcpServer {
  readonly origin: ContributionOrigin
  readonly name: string
  /*
   * 协议认得的那个对象。配置里那一格的写法归 MCP 规范所有，解码在这一层做完，
   * 下游拿到的就是能直接上线的形状。
   *
   * undefined 表示这台的传输本程序认不出。它照样留在列表里，因为开关要有落脚点。
   */
  readonly wire: McpServerWire | undefined
  /** 这一台自己的开关。界面上那个 Switch 显示的就是它。 */
  readonly enabled: boolean
  /** 本应用会把它交给会话。 */
  readonly active: boolean
}

/**
 * 本应用自己在进程里起的那一台。
 *
 * 地址由原生侧在启动时绑定并登记，这一层只是收下 —— 端口是内核分配的，谁都不需要
 * 事先约定一个数字。绑不上时 url 缺席：那一行仍然要显示，人才知道它为什么没起来，
 * 而不是以为自己没装。
 */
export interface BuiltinMcpServer {
  readonly name: string
  readonly url: string | undefined
  /** 人在界面上拨的那个开关。 */
  readonly enabled: boolean
}

export interface ResolvedPrompt {
  /* 提示词只有插件声明得出来，所以这一条不需要来源这一维。 */
  readonly pluginId: string
  readonly text: string
  readonly bytes: number
}

export interface ResolvedContributions {
  readonly skills: readonly ResolvedSkill[]
  readonly commands: readonly ResolvedCommand[]
  readonly mcpServers: readonly ResolvedMcpServer[]
  /* 提示词没有管理界面，它是会话的载荷而不是一个可列举的实体，所以只收启用的。 */
  readonly prompts: readonly ResolvedPrompt[]
  readonly promptBytes: number
  readonly diagnostics: readonly PluginDiagnostic[]
}

export interface ContributionInput {
  readonly plugins: readonly InstalledPlugin[]
  /** 这台机器上已经配好的那些服务器。本应用只读，不写。 */
  readonly environment: readonly DeclaredMcpServer[]
  /** 本应用自己起的那些。 */
  readonly builtin: readonly BuiltinMcpServer[]
}

const BUILTIN_ORIGIN: BuiltinOrigin = { kind: 'builtin' }

export function resolveContributions(input: ContributionInput): ResolvedContributions {
  const skills: ResolvedSkill[] = []
  const commands: ResolvedCommand[] = []
  const mcpServers: ResolvedMcpServer[] = []
  const prompts: ResolvedPrompt[] = []
  const diagnostics: PluginDiagnostic[] = []

  let promptBytes = 0

  /* 自带的排最前，机器上那些次之：它们都先于任何插件存在，界面上也是这个次序。 */
  collectBuiltinServers(input.builtin, mcpServers)
  collectEnvironmentServers(input.environment, mcpServers)

  for (const plugin of resolutionOrder(input.plugins)) {
    const origin: ContributionOrigin = { kind: 'plugin', pluginId: plugin.pluginId }

    diagnostics.push(...plugin.diagnostics, ...plugin.registry.diagnostics)

    for (const skill of plugin.registry.skills) {
      skills.push({ skill, enabled: plugin.enabled })
    }

    for (const command of plugin.registry.commands) {
      commands.push({ command, enabled: plugin.enabled })
    }

    collectMcpServers(plugin, origin, mcpServers, diagnostics)

    promptBytes = collectPrompt(plugin, promptBytes, prompts, diagnostics)
  }

  return { commands, diagnostics, mcpServers, promptBytes, prompts, skills }
}

/*
 * 本应用自己起的那几台。
 *
 * 地址照样过 mcpServerWireOf：传输长什么样全仓只有 mcp-server 一处知道，内置这一支
 * 自己拼一个 { type: 'http', … } 出来，就是第二份关于传输的知识，迟早与那一处漂开。
 *
 * 认不出或者没地址时 active 为假 —— 送不出去的东西不能在界面上说成「会装载」。
 */
function collectBuiltinServers(
  servers: readonly BuiltinMcpServer[],
  into: ResolvedMcpServer[],
): void {
  for (const server of servers) {
    const wire =
      server.url === undefined ? undefined : mcpServerWireOf(server.name, { url: server.url })

    into.push({
      origin: BUILTIN_ORIGIN,
      name: server.name,
      wire,
      enabled: server.enabled,
      active: server.enabled && wire !== undefined,
    })
  }
}

/*
 * 机器上那份 mcp.json 里的服务器。
 *
 * active 恒假，而且这不是保守起见：装载它们的是那台 CLI 自己，本应用没有起过它们。
 * 写成真会让界面说一句本应用做不到的话。同理这里不记诊断 —— 那份文件不归本应用所有，
 * 认不出的传输由界面在那一行上说明，而不是变成一条挂在某个插件名下的诊断。
 */
function collectEnvironmentServers(
  declared: readonly DeclaredMcpServer[],
  into: ResolvedMcpServer[],
): void {
  for (const server of declared) {
    into.push({
      origin: server.origin,
      name: server.name,
      wire: mcpServerWireOf(server.name, server.config),
      enabled: server.enabledInConfig,
      active: false,
    })
  }
}

/* 关掉的那几台照样列出来，只是 active 是假 —— 不然开关就没有落脚点。 */
function collectMcpServers(
  plugin: InstalledPlugin,
  origin: ContributionOrigin,
  into: ResolvedMcpServer[],
  diagnostics: PluginDiagnostic[],
): void {
  const { pluginId } = plugin
  const disabled = new Set(plugin.disabledMcpServers)

  for (const server of plugin.manifest.mcpServers) {
    const enabled = !disabled.has(server.name)
    const wire = mcpServerWireOf(server.name, server.config)

    /* 认不出就说出来。与 hooks 那条同一个理由：声明了却不生效，静默等于骗人。 */
    if (wire === undefined) {
      diagnostics.push({
        code: 'mcp-transport-unrecognised',
        pluginId,
        detail: `"${server.name}"·的传输方式无法识别，本次会话没有装载它`,
      })
    }

    into.push({
      origin,
      name: server.name,
      wire,
      enabled,
      active: plugin.enabled && enabled,
    })
  }
}

/**
 * 这一份提示词进不进会话，以及进了之后预算还剩多少。
 *
 * 交回的是新的已用字节数：预算是一次遍历里累起来的一个数，谁改它就由谁说出来，
 * 不塞进一个可变对象里让调用方去猜。超预算的那一段不注入，但留一条诊断。
 */
function collectPrompt(
  plugin: InstalledPlugin,
  used: number,
  into: ResolvedPrompt[],
  diagnostics: PluginDiagnostic[],
): number {
  const text = plugin.systemPromptText

  if (!plugin.enabled || text === undefined) {
    return used
  }

  const { pluginId } = plugin
  const bytes = utf8ByteLength(text)

  if (used + bytes > SESSION_PROMPT_BUDGET_BYTES) {
    diagnostics.push({
      code: 'prompt-budget-exhausted',
      pluginId,
      detail: `会话提示词预算 ${SESSION_PROMPT_BUDGET_BYTES} 字节已用尽，这一段没有注入`,
    })

    return used
  }

  into.push({ pluginId, text, bytes })

  return used + bytes
}
