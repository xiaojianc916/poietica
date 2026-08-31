import type { AgentCapability, AgentCapabilityReport } from '@poietica/contract'
import type { InstalledPlugin } from './installation'

export const COMPUTER_USE = { capabilityId: 'kimi-cu' } as const

export type CapabilityInventory = { readonly kind: 'unread' } | AgentCapabilityReport
export const CAPABILITIES_UNREAD: CapabilityInventory = { kind: 'unread' }

/** 只描述本地命令生命周期；安装事实属于 KAP。 */
export type CapabilityCommand =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly capabilityId: string }
  | { readonly kind: 'failed'; readonly capabilityId: string; readonly reason: string }

export const CAPABILITY_COMMAND_IDLE: CapabilityCommand = { kind: 'idle' }

export type ComputerUse =
  | { readonly kind: 'unread' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'unlisted' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'installable' }
  | {
      readonly kind: 'installed'
      readonly pluginId: string
      readonly enabled: boolean
      readonly issue: string | undefined
    }

interface ComputerUseInput {
  readonly capabilities: CapabilityInventory
  readonly capabilityCommand: CapabilityCommand
  readonly plugins: readonly InstalledPlugin[]
}

function issueOf(capability: AgentCapability): string | undefined {
  if (capability.install.error !== null) {
    return capability.install.error
  }
  if (capability.state !== 'ready') {
    return '插件已安装，但 Kimi 运行时尚未就绪。'
  }
  return undefined
}

export function computerUse(input: ComputerUseInput): ComputerUse {
  const command = input.capabilityCommand
  const mine = command.kind !== 'idle' && command.capabilityId === COMPUTER_USE.capabilityId
  const failure = mine && command.kind === 'failed' ? command.reason : undefined

  if (mine && command.kind === 'pending') {
    return { kind: 'installing' }
  }
  if (input.capabilities.kind === 'unread') {
    return failure === undefined ? { kind: 'unread' } : { kind: 'failed', reason: failure }
  }
  if (input.capabilities.kind === 'unreachable') {
    return failure === undefined ? { kind: 'unreachable' } : { kind: 'failed', reason: failure }
  }

  const capability = input.capabilities.capabilities.find(
    (item) => item.id === COMPUTER_USE.capabilityId,
  )
  if (capability === undefined) {
    return { kind: 'unlisted' }
  }
  if (!capability.supported || capability.state === 'unsupported') {
    return { kind: 'unsupported' }
  }

  const plugin =
    capability.pluginId === null
      ? undefined
      : input.plugins.find((item) => item.pluginId === capability.pluginId)
  if (plugin !== undefined) {
    return {
      kind: 'installed',
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      issue: issueOf(capability),
    }
  }

  if (failure !== undefined) {
    return { kind: 'failed', reason: failure }
  }
  if (capability.install.error !== null) {
    return { kind: 'failed', reason: capability.install.error }
  }
  if (capability.install.running) {
    return { kind: 'installing' }
  }
  return { kind: 'installable' }
}
