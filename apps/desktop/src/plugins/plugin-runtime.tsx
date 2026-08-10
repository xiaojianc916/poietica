import { createAgentPaletteBridge } from '@poietica/ipc'
import type { McpServerWire } from '@poietica/plugins'
import { createPluginStore } from '@poietica/plugins'
import { useEffect } from 'react'

/*
 * 市场目录在哪。
 *
 * 官方那一个：上游 apps/kimi-code/src/constant/app.ts 里
 * KIMI_CODE_PLUGIN_MARKETPLACE_URL = \`\${KIMI_CODE_CDN_BASE}/plugins/marketplace.json\`，
 * 而 KIMI_CODE_CDN_BASE 是 https://code.kimi.com/kimi-code；官方文档
 * docs/{zh,en}/configuration/env-vars.md 把同一串逐字写在
 * KIMI_CODE_PLUGIN_MARKETPLACE_URL 一节里。
 *
 * 不是仓库里那份 plugins/marketplace.json：那一份是源码检出时的兜底（上游
 * getSourceCheckoutMarketplaceLocation 返回 '../../../../plugins/marketplace.json'，
 * 只在没配来源且 CDN 取失败时才用），条目写的是相对本地路径，而且它不随发布走 ——
 * 官方发布了什么，只有 CDN 上那一份说得准。
 *
 * 顺带解决一件与目录无关的事：取目录这一步从此不碰 GitHub。第三方条目的插件本体仍在
 * GitHub 上，但「插件页能不能打开」不再取决于 GitHub 通不通。
 */
const MARKETPLACE_URL = 'https://code.kimi.com/kimi-code/plugins/marketplace.json'

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
