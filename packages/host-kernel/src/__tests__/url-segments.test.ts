import { describe, expect, test } from 'bun:test'
import { safePathSegments } from '../url-segments'

describe('safePathSegments', () => {
  test('空段丢掉，其余逐段解码', () => {
    expect(safePathSegments('/ab%20cd//file.png')).toEqual(['ab cd', 'file.png'])
    expect(safePathSegments('/')).toEqual([])
  })

  test('坏的百分号编码、. / ..、解码后的分隔符与 NUL → undefined', () => {
    for (const pathname of ['/%E0%A4%A', '/.', '/%2e%2e', '/..%2Fsecret', '/a%5Cb', '/a%00b']) {
      expect(safePathSegments(pathname)).toBeUndefined()
    }
  })
})
