/*
 * 内置浏览器的 CDP 端点每次启动都重抽，而 agent 那条路要的是「此刻的端点」：这里在启动时对齐一次。
 *
 * 写 agent 自己的设置层（browser.cdpUrl），与设置页「电脑控制」同一个写入面 —— 不手搓文件，
 * 也不另立一台 MCP 服务器去转一手。
 */

import type { PluginStore } from '@poietica/extension'
import { browserDevtoolsEndpoint } from '@poietica/native-bridge/browser'
import { warn } from '@poietica/problem'

import { isAlive } from './browser-endpoint-probe'

/*
 * 退役的那台：应用曾经往 mcp.json 里写一台 playwright MCP 来驱动内置浏览器。
 * agent 侧已有原生浏览器能力，而且它会按浏览器类服务器把这台过滤掉，于是这台只在
 * 设置页里存在、在会话里永远不出现。清理条件已满足，条目与它的写法一并删掉。
 */
const RETIRED_BROWSER_MCP = 'poietica-browser'

/*
 * 把 browser.cdpUrl 对齐到这一次启动的端点。
 *
 * agent 侧的浏览器有三档：自己拉的托管浏览器（cdpUrl 为 null）、用户指定的现成 CDP
 * （设置页默认给 9222）、以及应用内置这一台（cdpUrl = 本机端点）。前两档是用户的决定，
 * 启动时去改就是替用户做决定，所以这里只认「应用自己上一趟发的那个端点」。
 *
 * 判据是探活而不是地址形状：这两种端点在地址上完全一样（都是本机回环加端口），
 * 唯一可检查的区别是上一趟留下的那个随进程一起死了，而用户选的现成浏览器按定义在跑。
 * 探活由原生侧回答（browser_endpoint_reachable），渲染进程不做网络。
 *
 * 不跟的后果是坏掉而不是少个功能：端口每次启动重抽，留着上一趟的值等于让 agent 去连一个
 * 已经不存在的端点；而设置页按「cdpUrl === appEndpoint」判档，还会把它误读成
 * 「附着到现成浏览器」，用户看到的选择会自己变。
 */
export async function alignBrowserEndpoint(store: PluginStore): Promise<void> {
  /*
   * 收掉以前那台浏览器 MCP 的条目。它现在既没人写也没人用，留着就是设置页上一台
   * 永远不会出现在会话里的服务器；reconcile 的删除路径是幂等的（本来没有就什么都不做）。
   */
  await store.reconcileHostedServer(RETIRED_BROWSER_MCP, null).catch((cause: unknown) => {
    warn('旧的浏览器 MCP 条目没清掉', { scope: 'browser-endpoint', cause })
  })

  try {
    const endpoint = await browserDevtoolsEndpoint()

    /* 端点缺席（非 Windows 或还没分配）：没有可对齐的事实，什么都不做。 */
    if (endpoint === null) {
      return
    }

    const browser = store.getSnapshot().browser

    /* 托管那一档是 null：agent 自己拉浏览器，这里不认识任何端点。 */
    if (browser.kind !== 'ready' || browser.cdpUrl === null) {
      return
    }

    /* 已经对齐过（同值）就不写，省掉一次没意义的落盘。 */
    if (browser.cdpUrl === endpoint) {
      return
    }

    /* 那个地址还活着，就是用户自己选的现成浏览器，不是我们上一趟留下的死端点。 */
    if (await isAlive(browser.cdpUrl)) {
      return
    }

    store.setBrowserSettings({ cdpUrl: endpoint })
  } catch (cause) {
    warn('内置浏览器的 CDP 端点问不出来', { scope: 'browser-endpoint', cause })
  }
}
