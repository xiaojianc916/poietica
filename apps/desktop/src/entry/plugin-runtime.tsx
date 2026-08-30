import { createPluginStore } from '@poietica/extension'
import { extensionGateway } from '@poietica/native-bridge'
import { useEffect } from 'react'
import { reconcileAutomationsMcpServer } from './automations-mcp'
import { reconcileBrowserMcpServer } from './browser-mcp'

/*
 * 市场目录在哪。
 *
 * 官方那一个：上游 apps/kimi-code/src/constant/app.ts 里
 * KIMI_CODE_PLUGIN_MARKETPLACE_URL = `${KIMI_CODE_CDN_BASE}/plugins/marketplace.json`，
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
  gateway: extensionGateway,
  marketplaceUrl: MARKETPLACE_URL,
  now: () => new Date().toISOString(),
})

/*
 * 托管的那两台服务器在 mcp.json 里的条目，对齐到本次启动的端口。
 *
 * 在模块求值时出发，不等任何 effect：kap 在进程起来那一刻读 mcp.json，读到上一次启动
 * 的端口就是「closed unexpectedly」。谁要拉起 agent，先等这份落定。
 */
export const hostedMcpServersReady: Promise<void> = Promise.all([
  reconcileAutomationsMcpServer(pluginStore),
  reconcileBrowserMcpServer(pluginStore),
]).then(() => undefined)

export function PluginLoader() {
  useEffect(() => {
    void pluginStore.start()

    /* 谁 start 谁 stop：下一次装载重新首扫。 */
    return () => {
      pluginStore.stop()
    }
  }, [])

  return null
}
