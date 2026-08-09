import { describe, expect, it } from 'vitest'
import type { PluginManifest } from './manifest'
import type { MarkdownFile } from './markdown'
import { readRegistry } from './registry'

function manifestWith(parts: Partial<PluginManifest>): PluginManifest {
  return {
    name: 'demo',
    displayName: 'demo',
    description: undefined,
    version: undefined,
    developerName: undefined,
    homepage: undefined,
    capabilities: [],
    skillRoots: [],
    agentRoots: [],
    commandRoots: [],
    mcpServers: [],
    sessionStartSkill: undefined,
    skillInstructions: undefined,
    promptSources: [],
    ...parts,
  }
}

/* 盘上放着什么由每个用例自己说。读盘这一步在这里是一张表，判定因此能单独测。 */
function readerOf(tree: Readonly<Record<string, readonly MarkdownFile[]>>) {
  return async (declared: string) => tree[declared] ?? null
}

describe('readRegistry', () => {
  it('声明目录下那份 SKILL.md 变成一个真的技能', async () => {
    const registry = await readRegistry(
      'demo',
      manifestWith({ skillRoots: ['./skills'] }),
      readerOf({
        './skills': [
          {
            path: './skills/writing-plans/SKILL.md',
            contents: '---\nname: writing-plans\ndescription: 写计划\n---\n正文',
          },
        ],
      }),
    )

    expect(registry.skills.map((one) => one.invocation)).toEqual(['/skill:writing-plans'])
    expect(registry.diagnostics).toEqual([])
  })

  it('命令带上插件命名空间，非 .md 不算命令', async () => {
    const registry = await readRegistry(
      'vercel-plugin',
      manifestWith({ commandRoots: ['./commands'] }),
      readerOf({
        './commands': [
          { path: './commands/deploy.md', contents: '把这个项目发上去' },
          { path: './commands/notes.txt', contents: '不是命令' },
        ],
      }),
    )

    expect(registry.commands.map((one) => one.invocation)).toEqual(['/vercel-plugin:deploy'])
  })

  it('声明的路径不在盘上时记一条诊断，而不是静默为空', async () => {
    const registry = await readRegistry(
      'demo',
      manifestWith({ commandRoots: ['./commands'] }),
      readerOf({}),
    )

    expect(registry.commands).toEqual([])
    expect(registry.diagnostics.map((one) => one.code)).toEqual(['path-missing'])
  })

  it('两个声明根撞出同名技能时只留第一个，并说出来', async () => {
    const contents = '---\nname: same\ndescription: 一个名字\n---\n正文'
    const registry = await readRegistry(
      'demo',
      manifestWith({ skillRoots: ['./a', './b'] }),
      readerOf({
        './a': [{ path: './a/same/SKILL.md', contents }],
        './b': [{ path: './b/same/SKILL.md', contents }],
      }),
    )

    expect(registry.skills).toHaveLength(1)
    expect(registry.diagnostics.map((one) => one.code)).toEqual(['name-taken'])
  })
})
