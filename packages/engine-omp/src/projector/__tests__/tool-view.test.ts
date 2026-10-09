import { describe, expect, test } from 'bun:test'
import { toolResultTextOf, toolSummaryOf, toolTitleOf } from '../tool-view'

describe('toolTitleOf', () => {
  test('内置工具取中文标题；认不出的原样返回名字', () => {
    expect(toolTitleOf('read')).toBe('读取文件')
    expect(toolTitleOf('bash')).toBe('执行命令')
    expect(toolTitleOf('mystery_tool')).toBe('mystery_tool')
  })
})

describe('toolSummaryOf', () => {
  test('逐工具取主语', () => {
    expect(toolSummaryOf('read', { path: 'a.ts' })).toBe('a.ts')
    expect(toolSummaryOf('bash', { command: 'ls' })).toBe('ls')
    expect(toolSummaryOf('grep', { pattern: 'foo' })).toBe('foo')
    expect(toolSummaryOf('web_search', { query: '天气' })).toBe('天气')
    expect(toolSummaryOf('read', null)).toBe('')
    expect(toolSummaryOf('read', { nope: 1 })).toBe('')
  })
})

describe('toolResultTextOf', () => {
  test('从 omp 的 { content } 形状里取文本块', () => {
    expect(toolResultTextOf({ content: [{ type: 'text', text: '一行' }] })).toBe('一行')
    expect(toolResultTextOf('裸字符串')).toBe('裸字符串')
    expect(toolResultTextOf({ content: '直接是文本' })).toBe('直接是文本')
    expect(toolResultTextOf(null)).toBe('')
  })
})
