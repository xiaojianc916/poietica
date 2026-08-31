import type { AgentCapability, AgentCapabilityReport } from '@poietica/contract'
import type { InstalledPlugin } from './installation'

/**
 * 电脑控制在两本账里的名字。
 *
 * 能力号发给本机 kap，插件号回本机账本查开没开。两个都是稳定标识 —— 从哪取、装到哪，
 * 全由本机 kap 说，所以这里没有下载地址。
 */
export const COMPUTER_USE = {
  capabilityId: 'kimi-cu',
  pluginId: 'kimi-cu-win',
} as const

/** 问过本机 kap 之后的答复，加上「还没问」。 */
export type CapabilityInventory = { readonly kind: 'unread' } | AgentCapabilityReport

export const CAPABILITIES_UNREAD: CapabilityInventory = { kind: 'unread' }

/** 一次能力安装的进行时。kap 的 :install 幂等，所以重试就是再点一次。 */
export type CapabilityInstall =
  | { readonly kind: 'idle' }
  | { readonly kind: 'installing'; readonly capabilityId: string }
  | { readonly kind: 'refused'; readonly capabilityId: string; readonly reason: string }

export const CAPABILITY_INSTALL_IDLE: CapabilityInstall = { kind: 'idle' }

export interface ComputerUseStep {
  readonly label: string
  readonly satisfied: boolean
}

/**
 * 屏幕上那一行的全部状态。
 *
 * 分层就绪度来自 kap 的步骤，开关来自本机账本；两样各有归属方，这里只投影，不合并成
 * 一个布尔 —— 插件装上了而运行时没装，正是那个布尔说不出来的状态。
 */
export type ComputerUse =
  | { readonly kind: 'unread' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'unlisted' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'incomplete'; readonly steps: readonly ComputerUseStep[] }
  | {
      readonly kind: 'ready'
      readonly steps: readonly ComputerUseStep[]
      /** 本机账本里那一条的开关；账本里没有它就是没有开关可拨。 */
      readonly enabled: boolean | undefined
    }

interface ComputerUseInput {
  readonly capabilities: CapabilityInventory
  readonly capabilityInstall: CapabilityInstall
  readonly plugins: readonly InstalledPlugin[]
}

function stepsOf(capability: AgentCapability): readonly ComputerUseStep[] {
  return capability.steps.map((step) => ({ label: step.label, satisfied: step.satisfied }))
}

export function computerUse(input: ComputerUseInput): ComputerUse {
  const install = input.capabilityInstall
  const mine = install.kind !== 'idle' && install.capabilityId === COMPUTER_USE.capabilityId

  if (mine && install.kind === 'refused') {
    return { kind: 'refused', reason: install.reason }
  }

  if (mine && install.kind === 'installing') {
    return { kind: 'installing' }
  }

  if (input.capabilities.kind === 'unread') {
    return { kind: 'unread' }
  }

  if (input.capabilities.kind === 'unreachable') {
    return { kind: 'unreachable' }
  }

  const listed = input.capabilities.capabilities.find(
    (capability) => capability.id === COMPUTER_USE.capabilityId,
  )

  if (listed === undefined) {
    return { kind: 'unlisted' }
  }

  if (!listed.supported) {
    return { kind: 'unsupported' }
  }

  const steps = stepsOf(listed)

  if (steps.some((step) => !step.satisfied)) {
    return { kind: 'incomplete', steps }
  }

  return {
    kind: 'ready',
    steps,
    enabled: input.plugins.find((plugin) => plugin.pluginId === COMPUTER_USE.pluginId)?.enabled,
  }
}
