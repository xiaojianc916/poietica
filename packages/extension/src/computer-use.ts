import { assertUnreachable } from '@poietica/problem'
import type { PluginInstallSource } from './install-source'
import type { ResolvedMcpServer } from './mcp-servers'
import type { PluginsViewModel } from './plugin-store'

/*
 * 电脑控制这一件能力，投影成屏幕上那一行的几种样子。
 *
 * 它不持有状态：装了没有、开没开，答案在 agent 自己那份 installed.json 里，
 * PluginStore 是它在本进程里的唯一持有者。
 *
 * id 与归档地址钉在上游 kimi-code 的能力档案上（packages/agent-core-v2/src/app/
 * capability/entries/kimiCu.ts 的 Windows 那一档）。本仓 bundle 目标只有 nsis，
 * 所以这里不分平台。
 */

export const KIMI_COMPUTER_USE = {
  pluginId: 'kimi-cu-win',
  archiveUrl:
    'https://code.kimi.com/kimi-code/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip',
} as const

export const KIMI_COMPUTER_USE_SOURCE: PluginInstallSource = {
  kind: 'archive',
  url: KIMI_COMPUTER_USE.archiveUrl,
}

export type ComputerUseView =
  | { readonly kind: 'absent' }
  | { readonly kind: 'installing' }
  | {
      readonly kind: 'confirming'
      readonly displayName: string
      readonly version: string | undefined
    }
  | { readonly kind: 'refused'; readonly reason: string }
  | {
      readonly kind: 'installed'
      readonly enabled: boolean
      /* 开着这一行却不会装载的那几台：开启时一并拨回去，与官方装配的最后一步同一个判据。 */
      readonly needsEnabling: readonly ResolvedMcpServer[]
    }

function ours(source: PluginInstallSource): boolean {
  return source.kind === 'archive' && source.url === KIMI_COMPUTER_USE.archiveUrl
}

export function computerUseView(view: PluginsViewModel): ComputerUseView {
  const plugin = view.plugins.find((one) => one.pluginId === KIMI_COMPUTER_USE.pluginId)

  if (plugin !== undefined) {
    return {
      kind: 'installed',
      enabled: plugin.enabled,
      needsEnabling: view.mcpServers.filter(
        (server) =>
          !server.enabled &&
          server.origin.kind === 'plugin' &&
          server.origin.pluginId === plugin.pluginId,
      ),
    }
  }

  const { install } = view

  /* 安装槽只有一个：别人占着的时候这一行不认领它的状态。 */
  if (install.kind === 'idle' || !ours(install.source)) {
    return { kind: 'absent' }
  }

  switch (install.kind) {
    case 'staging':
      return { kind: 'installing' }
    case 'staged':
      return {
        kind: 'confirming',
        displayName: install.manifest.displayName,
        version: install.manifest.version,
      }
    case 'refused':
      return { kind: 'refused', reason: install.reason }
    default:
      return assertUnreachable(install)
  }
}
