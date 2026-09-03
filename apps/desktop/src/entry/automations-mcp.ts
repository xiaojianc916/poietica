/*
 * 受控 home 里 mcp.json 的 poietica-automations 条目，与本进程那台 MCP 服务器的对账。
 *
 * 端口由内核分配（apps/desktop/src-tauri/src/ipc/commands/automation/mcp_server.rs
 * 的 serve），所以地址每次启动都不同：
 * 有地址就把条目对齐过去，没有地址就拆掉条目。
 *
 * 会话读的是 mcp.json，本应用没有第二条路把服务器挂进会话 —— 所以「本进程自己起着它」
 * 必须落到那份文件里，否则它对会话不存在。
 *
 * 这一层只回答「自动化那台长什么样」。读—改—写交给插件 store：那份文件只有一个写者。
 */

import type { PluginStore } from '@poietica/extension'
import { readMcpEndpoint } from '@poietica/native-bridge'
import { warn } from '@poietica/problem'

const SERVER_NAME = 'poietica-automations'

/** 把 mcp.json 的自动化条目对齐到当前地址，并确保失败时不遗留旧端口。 */
export async function reconcileAutomationsMcpServer(store: PluginStore): Promise<void> {
  try {
    const url = (await readMcpEndpoint())?.url

    await store.reconcileHostedServer(SERVER_NAME, url === undefined ? null : { url })
  } catch (cause) {
    warn('自动化 MCP 服务器未能登记，正在移除可能过期的地址', {
      scope: 'automations-mcp',
      cause,
    })

    try {
      await store.reconcileHostedServer(SERVER_NAME, null)
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        '自动化 MCP 服务器既未能登记，也未能移除过期地址',
      )
    }
  }
}
