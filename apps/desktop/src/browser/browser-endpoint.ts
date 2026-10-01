/*
 * 内置浏览器的 CDP 端点。
 *
 * Electron 侧还没有对应物：WebView2 时代那个端口是长在环境参数上的，端口随应用启动重抽，
 * 所以启动时要把它对齐进 agent 自己的设置（browser.cdpUrl）。现在内置浏览器是主进程的
 * WebContentsView，CDP 端点还没有产地 —— 于是这一档在设置页里就是「没有内置浏览器」，
 * 不去写一个编出来的地址。
 *
 * 要重新接上时，产地只能是主进程：端口由它开，值也只能由它给。
 */

import type { PluginStore } from '@poietica/extension'
import { warn } from '@poietica/problem'

/*
 * 退役的那台：应用曾经往 mcp.json 里写一台 playwright MCP 来驱动内置浏览器。
 * agent 侧已有原生浏览器能力，而且它会按浏览器类服务器把这台过滤掉，于是这台只在
 * 设置页里存在、在会话里永远不出现。清理条件已满足，条目与它的写法一并删掉。
 */
const RETIRED_BROWSER_MCP = 'poietica-browser'

/*
 * 收掉以前那台浏览器 MCP 的条目。它现在既没人写也没人用，留着就是设置页上一台
 * 永远不会出现在会话里的服务器；reconcile 的删除路径是幂等的（本来没有就什么都不做）。
 */
export async function alignBrowserEndpoint(store: PluginStore): Promise<void> {
  await store.reconcileHostedServer(RETIRED_BROWSER_MCP, null).catch((cause: unknown) => {
    warn('旧的浏览器 MCP 条目没清掉', { scope: 'browser-endpoint', cause })
  })
}
