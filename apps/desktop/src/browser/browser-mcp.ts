/*
 * 受控 home 里 mcp.json 的 poietica-browser 条目，与内核 CDP 端点的对账。
 *
 * 端口每次启动随机抽取，所以端点每次启动都不同：有端点、且这台机器解析得出 npx 的
 * 启动式，就把条目对齐到它；缺任一个（非 Windows 起不来内核、端口被抢、机器上没有
 * Node）就拆掉条目 —— 写一条注定 ENOENT 的条目比不写更糟。
 *
 * 这一层只回答「浏览器那台长什么样」。读—改—写交给插件 store：那份文件只有一个写者，
 * 否则界面上的增删改与这一趟对账会在启动期互相抹掉。
 */

import { browserDevtoolsEndpoint, resolveLauncher } from '@poietica/native-bridge'
import type { PluginStore } from '@poietica/plugins'
import { warn } from '@poietica/problem'

const SERVER_NAME = 'poietica-browser'

/** 把 mcp.json 的浏览器条目对齐到当前内核端点。失败只记日志，不打断启动。 */
export async function reconcileBrowserMcpServer(store: PluginStore): Promise<void> {
  try {
    const [endpoint, launcher] = await Promise.all([
      browserDevtoolsEndpoint(),
      resolveLauncher('npx'),
    ])

    await store.reconcileHostedServer(
      SERVER_NAME,
      endpoint === null || launcher === null
        ? null
        : {
            command: launcher.program,
            args: [
              ...launcher.prefixArgs,
              '-y',
              '@playwright/mcp@latest',
              '--cdp-endpoint',
              endpoint,
            ],
          },
    )
  } catch (cause) {
    warn('内置浏览器的 CDP 端点问不出来', { scope: 'browser-mcp', cause })
  }
}
