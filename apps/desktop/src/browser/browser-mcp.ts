/*
 * 受控 home 里 mcp.json 的 poietica-browser 条目，与内核 CDP 端点的对账。
 *
 * 端口每次启动随机抽取，所以端点每次启动都不同：有端点就把条目对齐到
 * playwright-mcp + --cdp-endpoint，没有端点（非 Windows、端口被抢）就拆掉条目。
 *
 * 这一层只回答「浏览器那台长什么样」。读—改—写交给插件 store：那份文件只有一个写者，
 * 否则界面上的增删改与这一趟对账会在启动期互相抹掉。
 */

import { warn } from '@poietica/core'
import { browserDevtoolsEndpoint } from '@poietica/ipc'
import type { PluginStore } from '@poietica/plugins'

const SERVER_NAME = 'poietica-browser'

/** 把 mcp.json 的浏览器条目对齐到当前内核端点。失败只记日志，不打断启动。 */
export async function reconcileBrowserMcpServer(store: PluginStore): Promise<void> {
  try {
    const endpoint = await browserDevtoolsEndpoint()

    store.reconcileHostedServer(
      SERVER_NAME,
      endpoint === null
        ? null
        : { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--cdp-endpoint', endpoint] },
    )
  } catch (cause) {
    warn('内置浏览器的 CDP 端点问不出来', { scope: 'browser-mcp', cause })
  }
}
