import { describe, expect, it } from 'bun:test'
import { manifestBase } from '../manifest.ts'

describe('manifestBase', () => {
  it('resolves the repository behind a latest-release endpoint', () => {
    expect(
      manifestBase(
        'https://github.com/xiaojianc916/poietica/releases/latest/download/latest.json\n',
      ),
    ).toBe('https://github.com/xiaojianc916/poietica')
  })

  it('rejects a non-GitHub origin', () => {
    expect(
      manifestBase(
        'https://example.com/xiaojianc916/poietica/releases/latest/download/latest.json',
      ),
    ).toBeNull()
  })

  it('rejects a path that is not the latest-release manifest route', () => {
    expect(
      manifestBase('https://github.com/xiaojianc916/poietica/releases/download/v0.2.2/latest.json'),
    ).toBeNull()
  })

  it('rejects malformed URLs', () => {
    expect(manifestBase('not a url')).toBeNull()
  })
})
