import { describe, expect, it } from 'bun:test'
import { CAPABILITY_COMMAND_IDLE, type CapabilityCommand, computerUse } from './capability'
import type { InstalledPlugin } from './installation'
import type { AgentCapability } from './model'

const base: AgentCapability = {
  id: 'computer-use',
  pluginId: 'computer-use-win',
  label: 'Oh My Pi Computer Use',
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
    expect(
      project({ ...base, state: 'notInstalled' }, [installed('computer-use-win', true)]),
    ).toEqual({
      kind: 'installable',
    })
  })

  it('offers repair for a partial enabled installation', () => {
    expect(project(base, [installed('computer-use-win', true)])).toEqual({ kind: 'repairable' })
  })

  it('keeps the official plugin switch for a disabled partial installation', () => {
    expect(project(base, [installed('computer-use-win', false)])).toEqual({
      kind: 'installed',
      pluginId: 'computer-use-win',
      enabled: false,
    })
  })

  it('uses the platform plugin id reported by KAP', () => {
    const mac = { ...base, pluginId: 'computer-use', state: 'ready' as const }
    expect(project(mac, [installed('computer-use', true)])).toEqual({
      kind: 'installed',
      pluginId: 'computer-use',
      enabled: true,
    })
  })

  it('keeps installation stable while the command is pending', () => {
    expect(project(base, [], { kind: 'pending', capabilityId: 'computer-use' })).toEqual({
      kind: 'installing',
    })
  })

  it('surfaces connection and installation failures separately', () => {
    expect(
      computerUse({
        capabilities: { kind: 'failed', reason: 'the agent failed to start' },
        capabilityCommand: CAPABILITY_COMMAND_IDLE,
        plugins: [],
      }),
    ).toEqual({ kind: 'unavailable', reason: 'the agent failed to start' })
    expect(project({ ...base, install: { ...base.install, error: 'runtime failed' } })).toEqual({
      kind: 'failed',
      reason: 'runtime failed',
    })
  })

  it('does not let an ambiguous command error override observed readiness', () => {
    expect(
      project({ ...base, state: 'ready' }, [], {
        kind: 'failed',
        capabilityId: 'computer-use',
        reason: 'connection closed after acceptance',
      }),
    ).toEqual({ kind: 'ready' })
  })
})
