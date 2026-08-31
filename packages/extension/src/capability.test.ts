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
  it('shows install when the capability plugin is absent', () => {
    expect(project(base)).toEqual({ kind: 'installable' })
  })

  it('shows the ledger switch even when a disabled plugin makes capability partial', () => {
    expect(project(base, [installed('kimi-cu-win', false)])).toEqual({
      kind: 'installed',
      pluginId: 'kimi-cu-win',
      enabled: false,
      issue: '插件已安装，但 Kimi 运行时尚未就绪。',
    })
  })

  it('uses the plugin id reported by KAP on every platform', () => {
    const mac = { ...base, pluginId: 'kimi-cu', state: 'ready' as const }
    expect(project(mac, [installed('kimi-cu', true)])).toEqual({
      kind: 'installed',
      pluginId: 'kimi-cu',
      enabled: true,
      issue: undefined,
    })
  })

  it('keeps the installation state stable while the command is pending', () => {
    expect(project(base, [], { kind: 'pending', capabilityId: 'kimi-cu' })).toEqual({
      kind: 'installing',
    })
  })

  it('surfaces the KAP installation error and allows retry', () => {
    expect(project({ ...base, install: { ...base.install, error: 'runtime failed' } })).toEqual({
      kind: 'failed',
      reason: 'runtime failed',
    })
  })
})
