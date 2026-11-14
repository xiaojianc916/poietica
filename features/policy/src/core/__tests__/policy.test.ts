import { describe, expect, test } from 'bun:test'
import { classifyTool, evaluateClassification, evaluatePolicy } from '../policy'

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
    ).toBe('allow')
    expect(evaluateClassification('auto-edit', { category: 'exec', risk: 'high', checkpoint: true }).action).toBe('ask')
  })

  test('网络与未知工具保守处理', () => {
    expect(evaluatePolicy('read-only', 'fetch').action).toBe('deny')
    expect(evaluatePolicy('auto-edit', 'fetch').action).toBe('ask')
    expect(evaluatePolicy('auto-edit', 'brand_new_tool').action).toBe('ask')
    expect(evaluatePolicy('full-access', 'brand_new_tool').action).toBe('allow')
  })
})
