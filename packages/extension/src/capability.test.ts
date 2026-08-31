import { describe, expect, it } from 'bun:test'
import type { AgentCapability } from '@poietica/contract'
import { CAPABILITY_COMMAND_IDLE, type CapabilityCommand, computerUse } from './capability'
import type { InstalledPlugin } from './installation'

const base: AgentCapability = {
  id: 'kimi-cu',
  pluginId: 'kimi-cu-win',
  label: 'Kimi Computer Use',
  supported: true,
  state: 'partial',
  install: { running: false, step: null, percent: null, error: null },
}

function project(
  capability: AgentCapability,
  plugins: readonly InstalledPlugin[] = [],
  capabilityCommand: CapabilityCommand = CAPABILITY_COMMAND_IDLE,
) {
  return computerUse({
    capabilities: { kind: 'reported', capabilities: [capability] },
    capabilityCommand,
    plugins,
  })
}

function installed(pluginId: string, enabled: boolean): InstalledPlugin {
  return { pluginId, enabled } as InstalledPlugin
}

describe('computerUse', () => {
  it('uses KAP readiness as the installation truth', () => {
    expect(project({ ...base, state: 'ready' })).toEqual({ kind: 'ready' })
    expect(project({ ...base, state: 'notInstalled' }, [installed('kimi-cu-win', true)])).toEqual({
      kind: 'installable',
    })
  })

  it('offers repair for a partial enabled installation', () => {
    expect(project(base, [installed('kimi-cu-win', true)])).toEqual({ kind: 'repairable' })
  })

  it('keeps the official plugin switch for a disabled partial installation', () => {
    expect(project(base, [installed('kimi-cu-win', false)])).toEqual({
      kind: 'installed',
      pluginId: 'kimi-cu-win',
      enabled: false,
    })
  })

  it('uses the platform plugin id reported by KAP', () => {
    const mac = { ...base, pluginId: 'kimi-cu', state: 'ready' as const }
    expect(project(mac, [installed('kimi-cu', true)])).toEqual({
      kind: 'installed',
      pluginId: 'kimi-cu',
      enabled: true,
    })
  })

  it('keeps installation stable while the command is pending', () => {
    expect(project(base, [], { kind: 'pending', capabilityId: 'kimi-cu' })).toEqual({
      kind: 'installing',
    })
  })

  it('surfaces connection and installation failures separately', () => {
    expect(
      computerUse({
        capabilities: { kind: 'failed', reason: 'Kimi failed to start' },
        capabilityCommand: CAPABILITY_COMMAND_IDLE,
        plugins: [],
      }),
    ).toEqual({ kind: 'unavailable', reason: 'Kimi failed to start' })
    expect(project({ ...base, install: { ...base.install, error: 'runtime failed' } })).toEqual({
      kind: 'failed',
      reason: 'runtime failed',
    })
  })

  it('does not let an ambiguous command error override observed readiness', () => {
    expect(
      project({ ...base, state: 'ready' }, [], {
        kind: 'failed',
        capabilityId: 'kimi-cu',
        reason: 'connection closed after acceptance',
      }),
    ).toEqual({ kind: 'ready' })
  })
})
