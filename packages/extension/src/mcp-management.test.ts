import { describe, expect, it } from 'bun:test'
import {
  addMcpServers,
  decodeMcpConfig,
  mcpEntryFromForm,
  mcpServerBodyInConfig,
  parseMcpImport,
  removeMcpServer,
  setMcpServerEnabledInConfig,
  upsertMcpServer,
} from './mcp-config'

const origin = { kind: 'user' as const, location: '/agent/mcp.json' }

describe('MCP configuration editing', () => {
  it('does not turn malformed configuration into an empty document', () => {
    for (const contents of [
      '',
      '[]',
      'null',
      '{"mcpServers":[]}',
      '{"mcpServers":"invalid"}',
      '{"mcpServers":{"broken":[]}}',
    ]) {
      expect(() => upsertMcpServer(contents, 'added', { command: 'node' })).toThrow()
    }
    expect(decodeMcpConfig(origin, []).malformed).toBe(true)
    expect(decodeMcpConfig(origin, { mcpServers: { broken: [] } }).malformed).toBe(true)
  })

  it('adds a batch without losing existing fields and rejects duplicate names', () => {
    const contents = JSON.stringify({
      metadata: { keep: true },
      mcpServers: { installed: { command: 'node', cwd: '/a b', future: { keep: true } } },
    })
    const result = addMcpServers(
      contents,
      parseMcpImport('{"remote":{"url":"https://example.com/mcp"}}'),
    )
    expect(JSON.parse(result).mcpServers.installed).toEqual(
      JSON.parse(contents).mcpServers.installed,
    )
    expect(JSON.parse(result).metadata).toEqual({ keep: true })
    expect(() =>
      addMcpServers(contents, [{ name: 'installed', body: { command: 'other' } }]),
    ).toThrow()
    expect(() =>
      addMcpServers(null, [
        { name: 'a', body: { command: 'node' } },
        { name: 'a', body: { command: 'other' } },
      ]),
    ).toThrow()
  })

  it('uses own keys rather than inherited object properties', () => {
    const contents = addMcpServers(
      null,
      parseMcpImport(
        '{"__proto__":{"command":"node"},"constructor":{"url":"https://example.com"}}',
      ),
    )
    expect(Object.hasOwn(JSON.parse(contents).mcpServers, '__proto__')).toBe(true)
    expect(mcpServerBodyInConfig(null, 'toString')).toBeUndefined()
    expect(mcpServerBodyInConfig(contents, '__proto__')).toEqual({ command: 'node' })
  })

  it('preserves argument boundaries and optional fields', () => {
    const entry = mcpEntryFromForm(
      {
        name: 'local',
        transport: 'stdio',
        command: 'node',
        args: '["a b", "", "C:\\\\Program Files\\\\tool.js"]',
        env: '{"EMPTY":""}',
        cwd: '/a b',
        startupTimeoutMs: '30000',
      },
      { toolTimeoutMs: 40000, future: { keep: true } },
    )
    expect(entry.body['args']).toEqual(['a b', '', 'C:\\Program Files\\tool.js'])
    expect(entry.body['env']).toEqual({ EMPTY: '' })
    expect(entry.body['future']).toEqual({ keep: true })
    expect(entry.body['toolTimeoutMs']).toBe(40000)
  })

  it('supports both documented import envelopes and rejects silent metadata loss', () => {
    expect(parseMcpImport('{"mcpServers":{"remote":{"url":"https://example.com"}}}')).toEqual(
      parseMcpImport('{"remote":{"url":"https://example.com"}}'),
    )
    for (const contents of ['{}', '[]', '{"mcpServers":{}}', '{"mcpServers":{},"extra":true}']) {
      expect(() => parseMcpImport(contents)).toThrow()
    }
  })

  it('validates the official transport and timeout fields', () => {
    for (const body of [
      { url: 'file:///tmp/mcp' },
      { url: 'https://user:secret@example.com' },
      { command: 'node', url: 'https://example.com' },
      { command: 'node', args: 'a b' },
      { command: 'node', env: { TOKEN: 3 } },
      { command: 'node', startupTimeoutMs: 0 },
      { command: 'node', startupTimeoutMs: 2147483648 },
      { command: 'node', startupTimeoutMs: 1.5 },
      { command: 'node', type: 'stdio' },
    ]) {
      expect(() => parseMcpImport(JSON.stringify({ test: body }))).toThrow()
    }
    expect(
      parseMcpImport(
        '{"sse":{"transport":"sse","url":"https://example.com/sse","startupTimeoutMs":2147483647}}',
      ),
    ).toHaveLength(1)
  })

  it('does not leak invalid JSON payloads in public errors', () => {
    try {
      parseMcpImport('{"TOKEN":"do-not-print-this" invalid}')
    } catch (cause) {
      expect(String(cause)).not.toContain('do-not-print-this')
    }
  })

  it('disables without deleting and removes only the selected entry', () => {
    const contents =
      '{"mcpServers":{"a":{"command":"node","custom":1},"b":{"url":"https://example.com"}}}'
    const disabled = setMcpServerEnabledInConfig(contents, 'a', false)
    expect(JSON.parse(disabled).mcpServers.a).toEqual({
      command: 'node',
      custom: 1,
      enabled: false,
    })
    const enabled = setMcpServerEnabledInConfig(disabled, 'a', true)
    expect(JSON.parse(enabled)).toEqual(JSON.parse(contents))
    expect(JSON.parse(removeMcpServer(enabled, 'a')).mcpServers).toEqual({
      b: { url: 'https://example.com' },
    })
  })
})
