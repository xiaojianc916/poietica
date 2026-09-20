/* mcp.json 的唯一写者是插件 store：这里只对账，绕过它写文件会与界面增删改互相抹掉。 */

import type { PluginStore } from '@poietica/extension'
import { resolveLauncher } from '@poietica/native-bridge/agent/launcher'
import { browserDevtoolsEndpoint } from '@poietica/native-bridge/browser'
import { warn } from '@poietica/problem'

const SERVER_NAME = 'poietica-browser'

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
