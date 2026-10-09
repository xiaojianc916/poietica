import { describe, expect, test } from 'bun:test'
import { quoteWindowsArg } from '../quote'

const CASES: ReadonlyArray<readonly [string, string]> = [
  ['abc', 'abc'],
  ['', '""'],
  ['a b', '"a b"'],
  ['a"b', '"a\\"b"'],
  ['a\\b', 'a\\b'],
  ['a b\\', '"a b\\\\"'],
  ['a\\"b', '"a\\\\\\"b"'],
]

describe('quoteWindowsArg', () => {
  for (const [input, expected] of CASES) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(quoteWindowsArg(input)).toBe(expected)
    })
  }
})
