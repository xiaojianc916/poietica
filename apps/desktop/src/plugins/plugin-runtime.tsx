import { createAgentPaletteBridge } from '@poietica/ipc'
import type { McpServerWire } from '@poietica/plugins'
import { createPluginStore } from '@poietica/plugins'
import { useEffect } from 'react'

/*
 * 应用层只做两件事：把市场地址与时钟交进去，然后在挂载时开表。
 *
 * 上游用 KIMI_CODE_PLUGIN_MARKETPLACE_URL 覆盖这个地址。
 */

const MARKETPLACE_URL =
  'https://raw.githubusercontent.com/MoonshotAI/kimi-code/main/plugins/marketplace.json'

export const pluginStore = createPluginStore({
  marketplaceUrl: MARKETPLACE_URL,
  now: () => new Date().toISOString(),
  /* 命令表这条端口在这里接上：领域层声明它，平台层实现它，两者只在组合根相见。 */
  palette: createAgentPaletteBridge(),
})

export function PluginLoader() {
  /* start() 自己幂等，也不持有订阅，所以这个 effect 没有东西要清理。 */
  useEffect(() => {
    pluginStore.start()
  }, [])

  return null
}

/*
 * 会话此刻真的会拿到的那三样东西。
 *
 * 都是一次求值，不是一个值：桥在启动时就建好，而插件随时会被装上、拨掉或卸载 —— 捕获
 * 建桥那一刻的答案，等于把第一帧的猜测钉死一整个进程。与 launch 和 cwd 同一条规矩。
 */
export function activeMcpServers(): readonly McpServerWire[] {
  const { contributions } = pluginStore.getSnapshot()

  /* 传输认不出的那几台在这里落地：诊断已经在解析那一层记过，这里不重复报，也不假装能送。 */
  return contributions.mcpServers.flatMap((server) =>
    server.active && server.wire !== undefined ? [server.wire] : [],
  )
}
