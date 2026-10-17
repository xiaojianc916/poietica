import { describe, expect, test } from 'bun:test'
import { mcpEntryFromForm, parseMcpImport, serverNameError, validateMcpEntry } from '../mcp-config'

/*
 * MCP 配置的字段表与校验：名称按 omp 的 `validateServerName` 判、请求超时落到 `timeout`、
 * 表单不再写出 omp 不认的键。失败要带 `field`，界面才能把红字放到那一格旁边。
 */

describe('serverNameError', () => {
  test('带斜杠、空名、超长、双空格都拒', () => {
    expect(serverNameError('foo/bar')).not.toBeNull()
    expect(serverNameError('')).not.toBeNull()
    expect(serverNameError('a'.repeat(101))).not.toBeNull()
    expect(serverNameError('a  b')).not.toBeNull()
  })

  /* omp 的判据允许命名空间冒号、单个空格的人话标签与 100 字符上限。 */
  test('omp 认的那些形状都通过', () => {
    for (const name of ['atlassian:atlassian', 'MaaS Slack', 'a.b-c_d:e', 'a'.repeat(100)]) {
      expect(serverNameError(name)).toBeNull()
    }
  })
})

describe('validateMcpEntry', () => {
  test('名称不合法：错误挂在 name 那一格', () => {
    expect(validateMcpEntry('foo/bar', { transport: 'http', url: 'https://x.test/mcp' })).toEqual({
      ok: false,
      message: '名称只能包含字母、数字、连字符、下划线、点与冒号；词之间只允许一个空格。',
      field: 'name',
    })
  })

  test('超时：-1 拒于 timeout 那一格，0 是合法的（omp 用它表示关闭超时）', () => {
    expect(validateMcpEntry('x', { transport: 'stdio', command: 'npx', timeout: -1 })).toMatchObject({
      ok: false,
      field: 'timeout',
    })
    expect(validateMcpEntry('x', { transport: 'stdio', command: 'npx', timeout: 0 }).ok).toBe(true)
  })

  test('URL 不是 http/https：错误挂在 url 那一格', () => {
    expect(validateMcpEntry('x', { transport: 'http', url: 'ftp://x.test/mcp' })).toMatchObject({
      ok: false,
      field: 'url',
    })
  })
})

describe('mcpEntryFromForm', () => {
  /* 四个死键在 omp 一个都不认；表单收下它们等于写进一份永不生效的配置。 */
  test('表单不再写出 omp 不认的键', () => {
    const result = mcpEntryFromForm({
      bearerTokenEnvVar: 'MCP_TOKEN',
      name: 'x',
      startupTimeoutMs: '5000',
      toolTimeoutMs: '1',
      transport: 'http',
      url: 'https://x.test/mcp',
    })

    if (!result.ok) throw new Error(result.message)
    expect('bearerTokenEnvVar' in result.value.config).toBe(false)
    expect('startupTimeoutMs' in result.value.config).toBe(false)
    expect('toolTimeoutMs' in result.value.config).toBe(false)
    expect('enabledTools' in result.value.config).toBe(false)
    expect('disabledTools' in result.value.config).toBe(false)
  })

  test('请求超时写进 timeout；0 原样保留，空着不写键', () => {
    const zero = mcpEntryFromForm({ command: 'npx', name: 'x', timeout: '0', transport: 'stdio' })
    const blank = mcpEntryFromForm({ command: 'npx', name: 'x', timeout: '  ', transport: 'stdio' })

    if (!zero.ok || !blank.ok) throw new Error('这两次都该通过')
    expect(zero.value.config.timeout).toBe(0)
    expect('timeout' in blank.value.config).toBe(false)
  })

  test('坏 JSON 的字段能指认：args / headers', () => {
    expect(mcpEntryFromForm({ args: '[oops', command: 'npx', name: 'x', transport: 'stdio' })).toMatchObject({
      ok: false,
      field: 'args',
    })
    expect(
      mcpEntryFromForm({ headers: '{oops', name: 'x', transport: 'http', url: 'https://x.test/mcp' }),
    ).toMatchObject({ ok: false, field: 'headers' })
  })
})

describe('parseMcpImport', () => {
  /* 导入是整份配置的落地通道：不指向某一格，所以不带 field，底部横幅承接。 */
  test('JSON 语法错误不带字段位', () => {
    const result = parseMcpImport('{')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.field).toBeUndefined()
  })

  test('批量导入里有一台名称不合法：停在那台，并指认 name', () => {
    expect(parseMcpImport(JSON.stringify({ 'a/b': { type: 'stdio', command: 'npx' } }))).toMatchObject({
      ok: false,
      field: 'name',
    })
  })
})
