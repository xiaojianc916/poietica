import { describe, expect, it } from 'bun:test'
import { DEFAULT_AGENT_ROOT, DEFAULT_SKILL_ROOT, decodePluginManifest } from './manifest'

function accept(raw: Record<string, unknown>) {
  const decoded = decodePluginManifest({ name: 'demo', ...raw })

  if (decoded.kind !== 'accepted') {
    throw new Error(decoded.diagnostics.map((entry) => entry.detail).join('; '))
  }

  return decoded
}

describe('decodePluginManifest', () => {
  it('名字不合规就整份拒收', () => {
    expect(decodePluginManifest({ name: 'Demo Plugin' }).kind).toBe('rejected')
    expect(decodePluginManifest({}).kind).toBe('rejected')
  })

  it('技能、代理、命令都是路径，一条与一串等价', () => {
    expect(accept({ skills: './skills/' }).manifest.skillRoots).toEqual(['./skills/'])
    expect(accept({ skills: ['./a', './b'] }).manifest.skillRoots).toEqual(['./a', './b'])
    expect(accept({ commands: ['./commands'] }).manifest.commandRoots).toEqual(['./commands'])
  })

  it('省略时有官方规定的落点', () => {
    const { manifest } = accept({})

    expect(manifest.skillRoots).toEqual([DEFAULT_SKILL_ROOT])
    expect(manifest.agentRoots).toEqual([DEFAULT_AGENT_ROOT])
    expect(manifest.commandRoots).toEqual([])
  })

  it('跑出插件根的路径被丢掉并留下诊断', () => {
    const decoded = accept({ skills: ['./ok', '../escape', '/abs'] })

    expect(decoded.manifest.skillRoots).toEqual(['./ok'])
    expect(decoded.diagnostics.map((entry) => entry.code)).toEqual([
      'path-escapes-root',
      'path-escapes-root',
    ])
  })

  it('两段提示词按顺序并存，不再判成互斥', () => {
    const { manifest } = accept({ systemPrompt: '内联', systemPromptPath: './SYSTEM.md' })

    expect(manifest.promptSources).toEqual([
      { kind: 'inline', text: '内联' },
      { kind: 'file', path: './SYSTEM.md' },
    ])
  })

  it('已废弃字段与 hook 各留一条诊断', () => {
    const decoded = accept({ tools: [], hooks: [{ event: 'PreToolUse' }] })

    expect(decoded.diagnostics.map((entry) => entry.code)).toEqual([
      'unsupported-field',
      'hooks-not-executed',
    ])
  })

  it('interface 覆盖顶层的说明与主页', () => {
    const { manifest } = accept({
      description: '长的',
      homepage: 'https://example.com',
      interface: {
        displayName: 'Demo',
        shortDescription: '短的',
        websiteURL: 'https://demo.example',
        capabilities: ['Read'],
      },
    })

    expect(manifest.displayName).toBe('Demo')
    expect(manifest.description).toBe('短的')
    expect(manifest.homepage).toBe('https://demo.example')
    expect(manifest.capabilities).toEqual(['Read'])
  })
})
