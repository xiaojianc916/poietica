/*
 * 受控 home 里 mcp.json 的 poietica-browser 条目，与内核 CDP 端点的对账。
 *
 * 端口每次启动随机抽取，所以端点每次启动都不同：有端点就把条目对齐到
 * playwright-mcp + --cdp-endpoint，没有端点（非 Windows、端口被抢）就拆掉
 * 条目。写入走 CAS：输给并发写家就放弃这一轮，下次启动再对账。
 */

import { warn } from '@poietica/core'
import {
  browserDevtoolsEndpoint,
  readEnvironmentMcpConfig,
  writeEnvironmentMcpConfig,
} from '@poietica/ipc'
import { mcpServerBodyInConfig, removeMcpServer, upsertMcpServer } from '@poietica/plugins'

const SERVER_NAME = 'poietica-browser'

/** 把 mcp.json 的浏览器条目对齐到当前内核端点。失败只记日志，不打断启动。 */
export async function reconcileBrowserMcpServer(): Promise<void> {
  try {
    const [endpoint, file] = await Promise.all([
      browserDevtoolsEndpoint(),
      readEnvironmentMcpConfig(),
    ])
    const current = mcpServerBodyInConfig(file.contents, SERVER_NAME)

    if (endpoint === null && current === undefined) {
      return
    }

    const next =
      endpoint === null
        ? removeMcpServer(file.contents, SERVER_NAME)
        : upsertMcpServer(file.contents, SERVER_NAME, {
            ...current,
            command: 'npx',
            args: ['-y', '@playwright/mcp@latest', '--cdp-endpoint', endpoint],
          })

    if (next === file.contents) {
      return
    }

    await writeEnvironmentMcpConfig(file.contents, next)
  } catch (cause) {
    warn('内置浏览器的 MCP 条目没对上账', { scope: 'browser-mcp', cause })
  }
}
