import type { InstalledPlugin } from './installation'
import type { AgentCapability } from './model'

/*
 * 桌面控制这项能力在 agent 报上来的清单里叫的名字。
 *
 * 它是**上游给的名字**，不是我们起的：条目由 agent 自己的插件目录分发，改这里等于
 * 认不出它。桥目前不报能力清单（capabilities 那条命令如实答「还没接」），所以这一格
 * 现在匹配不到东西；等桥接上再按实际情况核对。
 */
export const COMPUTER_USE = { capabilityId: 'computer-use' } as const

export type CapabilityInventory =
  | { readonly kind: 'unread' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'reported'; readonly capabilities: readonly AgentCapability[] }
export const CAPABILITIES_UNREAD: CapabilityInventory = { kind: 'unread' }

export type CapabilityCommand =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly capabilityId: string }
  | { readonly kind: 'failed'; readonly capabilityId: string; readonly reason: string }

export const CAPABILITY_COMMAND_IDLE: CapabilityCommand = { kind: 'idle' }

export type ComputerUse =
  | { readonly kind: 'unread' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'unlisted' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'installable' }
  | { readonly kind: 'repairable' }
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'installed'
      readonly pluginId: string
      readonly enabled: boolean
    }

interface ComputerUseInput {
  readonly capabilities: CapabilityInventory
  readonly capabilityCommand: CapabilityCommand
  readonly plugins: readonly InstalledPlugin[]
}

export function computerUse(input: ComputerUseInput): ComputerUse {
  const command = input.capabilityCommand
  const mine = command.kind !== 'idle' && command.capabilityId === COMPUTER_USE.capabilityId
  const failure = mine && command.kind === 'failed' ? command.reason : undefined

  if (mine && command.kind === 'pending') {
    return { kind: 'installing' }
  }

  const capabilities = input.capabilities
  if (capabilities.kind === 'unread') {
    return failure === undefined ? { kind: 'unread' } : { kind: 'failed', reason: failure }
  }
  if (capabilities.kind === 'failed') {
    return failure === undefined
      ? { kind: 'unavailable', reason: capabilities.reason }
      : { kind: 'failed', reason: failure }
  }

  const capability = capabilities.capabilities.find((item) => item.id === COMPUTER_USE.capabilityId)
  if (capability === undefined) {
    return { kind: 'unlisted' }
  }
  if (!capability.supported || capability.state === 'unsupported') {
    return { kind: 'unsupported' }
  }
  if (capability.install.running) {
    return { kind: 'installing' }
  }

  return settled(capability, input.plugins, failure)
}

/* ready 是就绪事实：ready 时命令失败与 install.error 都不作数（见 capability.test.ts）。 */
function settled(
  capability: AgentCapability,
  plugins: readonly InstalledPlugin[],
  failure: string | undefined,
): ComputerUse {
  const plugin =
    capability.pluginId === null
      ? undefined
      : plugins.find((item) => item.pluginId === capability.pluginId)

  if (capability.state === 'ready') {
    return plugin === undefined
      ? { kind: 'ready' }
      : { kind: 'installed', pluginId: plugin.pluginId, enabled: plugin.enabled }
  }

  if (failure !== undefined) {
    return { kind: 'failed', reason: failure }
  }
  if (capability.install.error !== null) {
    return { kind: 'failed', reason: capability.install.error }
  }

  if (capability.state === 'partial') {
    return plugin?.enabled === false
      ? { kind: 'installed', pluginId: plugin.pluginId, enabled: false }
      : { kind: 'repairable' }
  }

  return { kind: 'installable' }
}

/** agent 的浏览器控制设置；cdpUrl 为 null 即托管启动（agent 自己拉 Chromium）。 */
export type BrowserControl =
  | { readonly kind: 'unread' }
  | { readonly kind: 'failed'; readonly reason: string }
  | {
      readonly kind: 'ready'
      readonly enabled: boolean
      readonly headless: boolean
      readonly cdpUrl: string | null
      /** 本机内置浏览器的 CDP 端点；非 Windows 或未分配端口时为 null。 */
      readonly appEndpoint: string | null
    }

export interface BrowserSettingsPatch {
  readonly enabled?: boolean
  readonly headless?: boolean
  readonly cdpUrl?: string
}
