import { describe, expect, it } from 'bun:test'

import { decodeMcpConfig } from './mcp-config'
import type { ContributionOrigin } from './origin'

/* 夹具照抄 Kimi 官方 MCP 文档里那份 mcp.json 示例，不改写。 */
const USER: ContributionOrigin = { kind: 'user', location: '/home/me/.kimi-code/mcp.json' }

const DOCUMENTED = {
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
    linear: { url: 'https://mcp.linear.app/mcp' },
    'legacy-events': { transport: 'sse', url: 'https://mcp.example.com/sse' },
  },
}

describe('decodeMcpConfig', () => {
  it('官方示例里那三台都拆得出来，顺序照文档', () => {
    expect(decodeMcpConfig(USER, DOCUMENTED).servers.map((one) => one.name)).toEqual([
      'filesystem',
      'linear',
      'legacy-events',
    ])
  })

  it('每一台都带着自己的来源', () => {
    const [first] = decodeMcpConfig(USER, DOCUMENTED).servers

    expect(first?.origin).toEqual(USER)
  })

  it('缺省就是开着，enabled: false 是关着而不是不存在', () => {
    const decoded = decodeMcpConfig(USER, {
      mcpServers: { a: { url: 'https://example.com/mcp' }, b: { url: 'x', enabled: false } },
    })

    expect(decoded.servers.map((one) => one.enabledInConfig)).toEqual([true, false])
  })

  it('没有 mcpServers 那一格是空文档，不是坏文档', () => {
    expect(decodeMcpConfig(USER, {})).toEqual({ servers: [], malformed: false })
  })

  it('不是对象就是坏文档 —— 空与坏必须分得开', () => {
    expect(decodeMcpConfig(USER, ['nope']).malformed).toBe(true)
    expect(decodeMcpConfig(USER, null).malformed).toBe(true)
  })
})
