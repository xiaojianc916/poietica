import { describe, expect, it } from 'vitest'
import type { InstalledPlugin } from './installation'
import type { DeclaredMcpServer } from './mcp-config'
import { type BuiltinMcpServer, resolveMcpServers } from './mcp-servers'

interface PluginParts {
  readonly enabled?: boolean
  readonly installedAt?: string
  readonly mcpServerNames?: readonly string[]
  readonly disabledMcpServers?: readonly string[]
}

function plugin(name: string, parts: PluginParts = {}): InstalledPlugin {
  return {
    pluginId: name,
    manifest: {
      name,
      displayName: name,
      description: undefined,
      version: undefined,
      developerName: undefined,
      homepage: undefined,
      capabilities: [],
      skillRoots: [],
      agentRoots: [],
      commandRoots: [],
      mcpServerNames: parts.mcpServerNames ?? [],
      sessionStartSkill: undefined,
      skillInstructions: undefined,
      promptSources: [],
    },
    source: { kind: 'directory', path: `/tmp/${name}` },
    trust: 'third-party',
    enabled: parts.enabled ?? true,
    installedAt: parts.installedAt ?? '2026-01-01T00:00:00.000Z',
    disabledMcpServers: parts.disabledMcpServers ?? [],
    diagnostics: [],
  }
}

function declared(name: string, enabledInConfig: boolean): DeclaredMcpServer {
  return {
    name,
    origin: { kind: 'user', location: '/home/one/.kimi-code/mcp.json' },
    enabledInConfig,
  }
}

const RUNNING: BuiltinMcpServer = {
  name: 'poietica-automations',
  url: 'http://127.0.0.1:51234/mcp',
  enabled: true,
}

describe('resolveMcpServers', () => {
  it('内置的排最前，机器上那些次之，插件带来的最后', () => {
    const resolved = resolveMcpServers({
      builtin: [RUNNING],
      environment: [declared('from-config', true)],
      plugins: [plugin('demo', { mcpServerNames: ['from-plugin'] })],
    })

    expect(resolved.map((server) => server.name)).toEqual([
      'poietica-automations',
      'from-config',
      'from-plugin',
    ])
  })

  it('只有内置那一台是本应用亲手送进会话的', () => {
    const resolved = resolveMcpServers({
      builtin: [RUNNING],
      environment: [declared('from-config', true)],
      plugins: [plugin('demo', { mcpServerNames: ['from-plugin'] })],
    })

    expect(resolved.map((server) => server.launchedBy)).toEqual(['client', 'agent', 'agent'])
    expect(resolved.filter((server) => server.wire !== undefined)).toHaveLength(1)
    expect(resolved[0]?.wire).toEqual({
      type: 'http',
      name: 'poietica-automations',
      url: RUNNING.url,
    })
  })

  it('端口没绑上时那一行还在，只是没有人会起它', () => {
    const resolved = resolveMcpServers({
      builtin: [{ ...RUNNING, url: undefined }],
      environment: [],
      plugins: [],
    })

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.wire).toBeUndefined()
    expect(resolved[0]?.launchedBy).toBe('none')
  })

  it('内置那台关掉之后开关还在，只是不再送进会话', () => {
    const resolved = resolveMcpServers({
      builtin: [{ ...RUNNING, enabled: false }],
      environment: [],
      plugins: [],
    })

    expect(resolved[0]?.enabled).toBe(false)
    expect(resolved[0]?.launchedBy).toBe('none')
  })

  it('配置里写了 enabled: false 的那台，CLI 也不会起它', () => {
    const resolved = resolveMcpServers({
      builtin: [],
      environment: [declared('off', false)],
      plugins: [],
    })

    expect(resolved[0]?.enabled).toBe(false)
    expect(resolved[0]?.launchedBy).toBe('none')
  })

  it('单独关掉的那台留在列表里，开关因此有落脚点', () => {
    const resolved = resolveMcpServers({
      builtin: [],
      environment: [],
      plugins: [plugin('demo', { mcpServerNames: ['on', 'off'], disabledMcpServers: ['off'] })],
    })

    expect(resolved.map((server) => server.name)).toEqual(['on', 'off'])
    expect(resolved.map((server) => server.enabled)).toEqual([true, false])
    expect(resolved.map((server) => server.launchedBy)).toEqual(['agent', 'none'])
  })

  it('插件整体关掉时，那几台自己的开关不变，只是没有人起它们', () => {
    const resolved = resolveMcpServers({
      builtin: [],
      environment: [],
      plugins: [plugin('demo', { enabled: false, mcpServerNames: ['one'] })],
    })

    expect(resolved[0]?.enabled).toBe(true)
    expect(resolved[0]?.launchedBy).toBe('none')
  })

  it('插件之间按安装时刻排，同一批两次启动的次序一致', () => {
    const resolved = resolveMcpServers({
      builtin: [],
      environment: [],
      plugins: [
        plugin('late', { installedAt: '2026-01-03T00:00:00.000Z', mcpServerNames: ['c'] }),
        plugin('early', { installedAt: '2026-01-01T00:00:00.000Z', mcpServerNames: ['a'] }),
      ],
    })

    expect(resolved.map((server) => server.name)).toEqual(['a', 'c'])
  })
})
