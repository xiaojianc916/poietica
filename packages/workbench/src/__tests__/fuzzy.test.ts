import { expect, test } from 'bun:test'
import { fuzzyScore } from '../fuzzy'

/* 命令面板只拿它排序：空查询全过、对不上出局、命中按「连续 > 分散、词首 > 词中、短文本 > 长文本」排。 */
test('fuzzyScore：空查询全过，对不上出局，大小写不论', () => {
  expect(fuzzyScore('', 'anything')).toBe(0)
  expect(fuzzyScore('   ', 'anything')).toBe(0)
  expect(fuzzyScore('xyz', 'abc')).toBe(-1)
  expect(fuzzyScore('cp', 'command palette')).toBeGreaterThan(0)
  expect(fuzzyScore('CMD', 'command')).toBeGreaterThan(0)
})

test('fuzzyScore：连续命中压过分散，词首压过词中，短文本压过长文本', () => {
  expect(fuzzyScore('cmd', 'cmd xxx')).toBeGreaterThan(fuzzyScore('cmd', 'c m d'))
  expect(fuzzyScore('p', 'command palette')).toBeGreaterThan(fuzzyScore('p', 'commandpalette'))
  expect(fuzzyScore('abc', 'abc')).toBeGreaterThan(fuzzyScore('abc', 'abcdefghij'))
})
