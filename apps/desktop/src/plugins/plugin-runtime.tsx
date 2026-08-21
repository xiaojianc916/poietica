import { error as reportError } from '@poietica/core'
import { createAgentPaletteBridge } from '@poietica/ipc'
import { createPluginStore } from '@poietica/plugins'
import { useEffect } from 'react'
import { reconcileAutomationsMcpServer } from '../automations/automations-mcp'
import { reconcileBrowserMcpServer } from '../browser/browser-mcp'

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
  marketplaceUrl: MARKETPLACE_URL,
  now: () => new Date().toISOString(),
  /* 命令表这条端口在这里接上：领域层声明它，平台层实现它，两者只在组合根相见。 */
  palette: createAgentPaletteBridge({
    /* 接不上就说出来。这条通道没接上时插件页那张命令表永远是空的，而空表与
    「这个 agent 一条命令都没有」在屏幕上长得一模一样 —— 与另外五座桥同一条
    规矩（assistant/agent-runtime.ts 的 noteListenFailure）。 */
    onListenFailure: (cause: unknown) => {
      reportError('agent command palette subscription failed', {
        scope: 'plugin-runtime',
        operation: 'listen',
        cause,
      })
    },
  }),
})

export function PluginLoader() {
  useEffect(() => {
    void pluginStore.start()

    /*
     * 内核的 CDP 端口与本进程那台 MCP 服务器的端口都是每次启动随机抽，mcp.json 里的
     * 条目因此每次启动都要重新对账；对账自己消化失败，不影响插件运行时起步。
     */
    void reconcileAutomationsMcpServer(pluginStore)
    void reconcileBrowserMcpServer(pluginStore)

    /* start() 接上了命令表的订阅，所以这个 effect 有东西要收。 */
    return () => {
      pluginStore.stop()
    }
  }, [])

  return null
}
