import { describe, expect, test } from 'bun:test'
import { DEFAULT_MIME, kindOf, mimeOf } from '../mime'

describe('附件 mime 表', () => {
  test('常见扩展名', () => {
    expect(mimeOf('a.png')).toBe('image/png')
    expect(mimeOf('a.JPG')).toBe('image/jpeg')
    expect(mimeOf('a.webp')).toBe('image/webp')
    expect(mimeOf('a.svg')).toBe('image/svg+xml')
    expect(mimeOf('a.pdf')).toBe('application/pdf')
    expect(mimeOf('a.md')).toBe('text/markdown')
  })

  test('未知扩展名与没有扩展名都是 application/octet-stream', () => {
    expect(mimeOf('a.zzz')).toBe(DEFAULT_MIME)
    expect(mimeOf('README')).toBe(DEFAULT_MIME)
    expect(mimeOf('a.')).toBe(DEFAULT_MIME)
  })

  test('kind 由 mime 前缀决定', () => {
    expect(kindOf('image/png')).toBe('image')
    expect(kindOf('image/svg+xml')).toBe('image')
    expect(kindOf('application/pdf')).toBe('file')
    expect(kindOf('text/plain')).toBe('file')
  })
})
