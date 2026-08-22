import type { AgentMcpServer } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { composerPaletteGroups } from '../composer/composer-actions'

const server = (
  id: string,
  status: AgentMcpServer['status'],
  transport: AgentMcpServer['transport'],
  toolCount: number,
): AgentMcpServer => ({ id, name: id, status, transport, toolCount })

const source = {
  controls: [],
  onSelectControl: () => undefined,
}

describe('composer capability palette', () => {
  it('lists every MCP server as one row without protocol or tool-count jargon', () => {
    const groups = composerPaletteGroups({
      ...source,
      skills: [],
      mcpServers: [
        server('connected', 'connected', 'http', 2),
        server('starting', 'connecting', 'sse', 4),
        server('offline', 'disconnected', 'stdio', 7),
        server('broken', 'error', 'http', 1),
      ],
    })
    const mcp = groups.find((group) => group.id === 'mcp')

    expect(mcp?.heading).toBe('MCP')
    expect(mcp?.rows.map(({ label, detail }) => ({ label, detail }))).toEqual([
      { label: 'connected', detail: undefined },
      { label: 'starting', detail: '连接中' },
      { label: 'offline', detail: '未连接' },
      { label: 'broken', detail: '连接失败' },
    ])
  })

  it('keeps a skill display label separate from its invocation name', () => {
    const groups = composerPaletteGroups({
      ...source,
      mcpServers: [],
      skills: [{ name: 'research', label: '深度研究', description: '调查并形成报告' }],
    })
    const [row] = groups.find((group) => group.id === 'skills')?.rows ?? []

    expect(row?.label).toBe('深度研究')
    expect(row?.action).toEqual({ kind: 'insert', chip: { kind: 'skill', name: 'research' } })
  })
})
