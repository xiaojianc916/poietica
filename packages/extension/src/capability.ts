import type { AgentCapability } from '@poietica/contract'
import type { InstalledPlugin } from './installation'

export const COMPUTER_USE = { capabilityId: 'kimi-cu' } as const

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

  if (mine && command.kind === 'pending') return { kind: 'installing' }
  if (input.capabilities.kind === 'unread') {
    return failure === undefined ? { kind: 'unread' } : { kind: 'failed', reason: failure }
  }
  if (input.capabilities.kind === 'failed') {
    return failure === undefined
      ? { kind: 'unavailable', reason: input.capabilities.reason }
      : { kind: 'failed', reason: failure }
  }

  const capability = input.capabilities.capabilities.find(
    (item) => item.id === COMPUTER_USE.capabilityId,
  )
  if (capability === undefined) return { kind: 'unlisted' }
  if (!capability.supported || capability.state === 'unsupported') return { kind: 'unsupported' }
  if (capability.install.running) return { kind: 'installing' }

  const plugin =
    capability.pluginId === null
      ? undefined
      : input.plugins.find((item) => item.pluginId === capability.pluginId)

  if (capability.state === 'ready') {
    return plugin === undefined
      ? { kind: 'ready' }
      : { kind: 'installed', pluginId: plugin.pluginId, enabled: plugin.enabled }
  }

  if (failure !== undefined) return { kind: 'failed', reason: failure }
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
