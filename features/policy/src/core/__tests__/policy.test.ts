import { describe, expect, test } from 'bun:test'
import { classifyTool, evaluateClassification, evaluatePolicy, hostMatches, hostOf } from '../policy'

describe('policy', () => {
  test('工具分类与第 7 节表一致；未知工具按高风险', () => {
    expect(classifyTool('bash')).toMatchObject({ category: 'exec', risk: 'high', checkpoint: true })
    expect(classifyTool('apply_patch')).toMatchObject({ category: 'file.write', risk: 'medium', checkpoint: true })
    expect(classifyTool('read')).toMatchObject({ category: 'file.read', risk: 'low', checkpoint: false })
    expect(classifyTool('todo')).toMatchObject({ category: 'meta', risk: 'low' })
    expect(classifyTool('web_search')).toMatchObject({ category: 'network', risk: 'medium', checkpoint: false })
    expect(classifyTool('computer')).toMatchObject({ category: 'exec', risk: 'high', checkpoint: true })
    expect(classifyTool('checkpoint')).toMatchObject({ category: 'file.write', risk: 'medium', checkpoint: true })
    expect(classifyTool('lsp')).toMatchObject({ category: 'file.read', risk: 'low', checkpoint: false })
    expect(classifyTool('mcp__github__search')).toMatchObject({ category: 'mcp', risk: 'high', checkpoint: true })
    expect(classifyTool('brand_new_tool')).toMatchObject({ category: 'unknown', risk: 'high', checkpoint: true })
  })

  test('预设：只读禁写、询问要确认、工作区自动放行树内写入', () => {
    expect(evaluatePolicy('read-only', 'write', { workspaceRoot: 'C:/ws', paths: ['C:/ws/a'] }).action).toBe('deny')
    expect(evaluatePolicy('ask', 'write', { workspaceRoot: 'C:/ws', paths: ['C:/ws/a'] }).action).toBe('ask')
    expect(evaluatePolicy('auto-edit', 'write', { workspaceRoot: 'C:/ws', paths: ['C:/ws/a'] }).action).toBe('allow')
    expect(evaluatePolicy('auto-edit', 'write', { workspaceRoot: 'C:/ws', paths: ['C:/other/a'] }).action).toBe('ask')
  })

  test('命令：安全命令放行，危险命令按预设拦；完全访问仍拦系统级破坏', () => {
    expect(evaluatePolicy('auto-edit', 'bash', { command: 'git status' }).action).toBe('allow')
    expect(evaluatePolicy('auto-edit', 'bash', { command: 'rm -rf /' })).toMatchObject({
      action: 'ask',
      rule: 'command.recursive_delete',
    })
    expect(evaluatePolicy('full-access', 'bash', { command: 'format C:' })).toMatchObject({
      action: 'deny',
      rule: 'command.system_destructive',
    })
    expect(evaluatePolicy('full-access', 'bash', { command: 'echo y | format C: /fs:NTFS' })).toMatchObject({
      action: 'deny',
      rule: 'command.system_destructive',
    })
    expect(evaluatePolicy('full-access', 'bash', { command: 'cmd /c diskpart' })).toMatchObject({
      action: 'deny',
      rule: 'command.system_destructive',
    })
    /* `format` 作为参数或 cmdlet 名不是格式化磁盘：不得升级成 deny（否则只读诊断命令直接被拒）。 */
    for (const command of [
      'powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowTitle -match \'DeepSeek\'} | Format-Table Id, Path"',
      "docker inspect --format '{{.Id}}' app",
      'git log --format=%h -5',
    ]) {
      const decision = evaluatePolicy('auto-edit', 'bash', { command })
      expect(decision).not.toMatchObject({ action: 'deny', rule: 'command.system_destructive' })
    }
  })

  test('产品工具按 spec.approval 分类裁决，不再按名字查表', () => {
    expect(evaluateClassification('auto-edit', { category: 'file.read', risk: 'low', checkpoint: false }).action).toBe(
      'allow',
    )
    expect(
      evaluateClassification(
        'auto-edit',
        { category: 'file.write', risk: 'medium', checkpoint: true },
        { workspaceRoot: '/w' },
      ).action,
    ).toBe('ask')
    expect(
      evaluateClassification(
        'auto-edit',
        { category: 'file.write', risk: 'medium', checkpoint: true },
        { workspaceRoot: '/w', paths: ['/w2/a'] },
      ).action,
    ).toBe('ask')
    expect(evaluateClassification('auto-edit', { category: 'exec', risk: 'high', checkpoint: true }).action).toBe('ask')
  })

  test('网络与未知工具保守处理', () => {
    expect(evaluatePolicy('read-only', 'fetch').action).toBe('deny')
    expect(evaluatePolicy('auto-edit', 'fetch').action).toBe('ask')
    expect(evaluatePolicy('auto-edit', 'brand_new_tool').action).toBe('ask')
    expect(evaluatePolicy('full-access', 'brand_new_tool').action).toBe('allow')
  })
})

describe('网络出口规则', () => {
  test('主机名匹配按标签边界，通配含裸域，别的域不会被前缀骗过', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true)
    expect(hostMatches('example.com', 'EXAMPLE.COM')).toBe(true)
    expect(hostMatches('*.example.com', 'api.example.com')).toBe(true)
    expect(hostMatches('*.example.com', 'example.com')).toBe(true)
    expect(hostMatches('*.example.com', 'notexample.com')).toBe(false)
    expect(hostMatches('.example.com', 'a.b.example.com')).toBe(true)
    expect(hostMatches('example.com', 'evil-example.com')).toBe(false)
    expect(hostMatches('example.com', 'example.com.evil.io')).toBe(false)
    expect(hostMatches('', 'example.com')).toBe(false)
  })

  test('目标主机只从 http(s) 取；不是 URL 或没有主机就是 undefined', () => {
    expect(hostOf('https://api.github.com/repos')).toBe('api.github.com')
    expect(hostOf('http://127.0.0.1:8080/x')).toBe('127.0.0.1')
    expect(hostOf('file:///etc/passwd')).toBeUndefined()
    expect(hostOf('data:text/plain,hi')).toBeUndefined()
    expect(hostOf('not a url')).toBeUndefined()
    expect(hostOf('')).toBeUndefined()
  })

  test('auto-edit 命中白名单放行并写出命中的规则；未命中要求询问', () => {
    const allowed = evaluatePolicy('auto-edit', 'fetch', { url: 'https://api.github.com/user' })
    expect(allowed).toMatchObject({ action: 'allow', rule: 'network.allowlist' })
    expect(allowed.network).toEqual({
      action: 'allow',
      rule: 'network.allowlist',
      reason: '命中出口白名单：*.github.com',
      host: 'api.github.com',
    })

    const blocked = evaluatePolicy('auto-edit', 'fetch', { url: 'https://unknown.example/x' })
    expect(blocked).toMatchObject({ action: 'ask', rule: 'network.not_allowlisted' })
    expect(blocked.network).toMatchObject({ host: 'unknown.example', action: 'ask' })
    expect(blocked.reason).toContain('unknown.example')
  })

  test('只读档关着网络，白名单对它不开口子', () => {
    expect(evaluatePolicy('read-only', 'fetch', { url: 'https://api.github.com/user' })).toMatchObject({
      action: 'deny',
      rule: 'preset.read_only.network',
    })
  })

  test('完全访问不看白名单；无法解析的目标一律先问', () => {
    expect(evaluatePolicy('full-access', 'fetch', { url: 'https://anything.example/x' })).toMatchObject({
      action: 'allow',
      rule: 'preset.full_access',
    })
    expect(evaluatePolicy('full-access', 'fetch', { url: 'file:///etc/passwd' })).toMatchObject({
      action: 'ask',
      rule: 'network.unparsed',
    })
  })

  test('没有目标时退回档位默认：裁决里仍带一份 network 说明', () => {
    const ask = evaluatePolicy('ask', 'fetch')
    expect(ask).toMatchObject({ action: 'ask', rule: 'preset.network_ask' })
    expect(ask.network).toMatchObject({ action: 'ask', rule: 'preset.network_ask' })
    expect(ask.network?.host).toBeUndefined()
  })
})
