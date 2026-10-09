import { describe, expect, test } from 'bun:test'
import { fuzzyScore } from '../fuzzy'

describe('fuzzyScore', () => {
  test('空查询返回 0（全部匹配）', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
    expect(fuzzyScore('   ', 'anything')).toBe(0)
  })

  test('不匹配返回 -1', () => {
    expect(fuzzyScore('xyz', 'abc')).toBe(-1)
  })

  test('子序列匹配', () => {
    expect(fuzzyScore('cp', 'command palette')).toBeGreaterThan(0)
  })

  test('大小写不敏感', () => {
    expect(fuzzyScore('CMD', 'command')).toBeGreaterThan(0)
  })

  test('连续命中得分高于分散命中', () => {
    expect(fuzzyScore('cmd', 'cmd xxx')).toBeGreaterThan(fuzzyScore('cmd', 'c m d'))
  })

  test('词首命中加分', () => {
    expect(fuzzyScore('p', 'command palette')).toBeGreaterThan(fuzzyScore('p', 'commandpalette'))
  })

  test('更短的文本得分更高', () => {
    expect(fuzzyScore('abc', 'abc')).toBeGreaterThan(fuzzyScore('abc', 'abcdefghij'))
  })
})
