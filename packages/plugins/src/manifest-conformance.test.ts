import { describe, expect, it } from 'vitest'
import { decodePluginManifest } from './manifest'

/*
 * 上游真清单当夹具。
 *
 * 这份文件存在的唯一理由：这个解码器已经被我们自己想象出来的形状坑过三次 ——
 * 目录版本号写成 "2"（真值是 "1"）、skills 只认数组（kimi-webbridge 写的是一条
 * 字符串）、commands 建模成内联对象（vercel-plugin 写的是 ["./commands"]）。
 * 结构字段逐字取自上游仓库，长文案略去（它不参与解码）。
 */

const KIMI_DATASOURCE = {
  name: 'kimi-datasource',
  version: '3.3.0',
  description: 'Finance, macro, enterprise, academic, and legal data tools for Kimi Code.',
  keywords: ['finance', 'data-source', 'mcp', 'legal'],
  mcpServers: { data: { command: 'node', args: ['./bin/kimi-datasource.mjs'], cwd: './' } },
  interface: {
    displayName: 'Kimi Datasource',
    shortDescription: 'Finance, macro, enterprise, academic, and legal data tools',
    developerName: 'Moonshot AI',
  },
}

const KIMI_WEBBRIDGE = {
  $schema: 'https://kimi.com/schemas/kimi.plugin.schema.json',
  name: 'kimi-webbridge',
  version: '1.11.3',
  description: 'Control your real browser from Kimi Code via the local Kimi WebBridge daemon.',
  keywords: ['browser', 'webbridge', 'cdp', 'automation', 'web', 'scraping'],
  author: 'Moonshot AI',
  license: 'Proprietary',
  skills: './skills/',
  interface: {
    displayName: 'Kimi WebBridge',
    shortDescription: 'Control your real browser from Kimi Code',
    longDescription: 'Kimi WebBridge lets AI control the user real browser.',
    developerName: 'Moonshot AI',
    websiteURL: 'https://www.kimi.com/features/webbridge',
  },
}

const SUPERPOWERS = {
  name: 'superpowers',
  version: '6.2.0',
  description: 'An agentic skills framework and software development methodology.',
  author: { name: 'Jesse Vincent', email: 'jesse@fsck.com' },
  homepage: 'https://github.com/obra/superpowers',
  license: 'MIT',
  keywords: ['brainstorming', 'skills', 'planning', 'tdd'],
  skills: './skills/',
  sessionStart: { skill: 'using-superpowers' },
  skillInstructions: 'Kimi Code tool mapping for Superpowers skills.',
  interface: {
    displayName: 'Superpowers',
    shortDescription: 'Planning, TDD, debugging, and delivery workflows for coding agents',
    developerName: 'Jesse Vincent',
    capabilities: ['Interactive', 'Read', 'Write'],
    websiteURL: 'https://github.com/obra/superpowers',
  },
}

const VERCEL_PLUGIN = {
  name: 'vercel-plugin',
  version: '0.47.0',
  description: 'Comprehensive Vercel ecosystem plugin.',
  keywords: ['vercel', 'nextjs', 'ai-sdk'],
  homepage: 'https://github.com/vercel/vercel-plugin',
  license: 'Apache-2.0',
  author: { name: 'Vercel', url: 'https://github.com/vercel' },
  skills: ['./skills'],
  commands: ['./commands'],
  mcpServers: { vercel: { transport: 'http', url: 'https://mcp.vercel.com' } },
  interface: {
    displayName: 'Vercel',
    shortDescription: 'Vercel ecosystem expert.',
    developerName: 'Vercel',
    websiteURL: 'https://vercel.com',
  },
}

function manifestOf(raw: Record<string, unknown>) {
  const decoded = decodePluginManifest(raw)

  if (decoded.kind !== 'accepted') {
    throw new Error(decoded.diagnostics.map((entry) => entry.detail).join('; '))
  }

  return decoded.manifest
}

describe('上游真清单', () => {
  it('四份全部收下，一份都不判无效', () => {
    for (const raw of [KIMI_DATASOURCE, KIMI_WEBBRIDGE, SUPERPOWERS, VERCEL_PLUGIN]) {
      expect(decodePluginManifest(raw).kind).toBe('accepted')
    }
  })

  it('kimi-datasource 只带一台 MCP 服务器', () => {
    const manifest = manifestOf(KIMI_DATASOURCE)

    expect(manifest.mcpServerNames).toEqual(['data'])
    expect(manifest.commandRoots).toEqual([])
  })

  it('kimi-webbridge 的 skills 是一条字符串', () => {
    expect(manifestOf(KIMI_WEBBRIDGE).skillRoots).toEqual(['./skills/'])
  })

  it('superpowers 声明了会话开始技能与自报能力', () => {
    const manifest = manifestOf(SUPERPOWERS)

    expect(manifest.sessionStartSkill).toBe('using-superpowers')
    expect(manifest.capabilities).toEqual(['Interactive', 'Read', 'Write'])
  })

  it('vercel-plugin 的 commands 是目录路径，不是命令名', () => {
    const manifest = manifestOf(VERCEL_PLUGIN)

    expect(manifest.commandRoots).toEqual(['./commands'])
    expect(manifest.skillRoots).toEqual(['./skills'])
    expect(manifest.mcpServerNames).toEqual(['vercel'])
  })
})
