import { describe, expect, it } from 'bun:test'
import { manifestBase } from '../manifest.ts'

describe('manifestBase', () => {
  it('resolves a GitHub latest-release endpoint', () =>
    expect(
      manifestBase('https://github.com/xiaojianc916/poietica/releases/latest/download/latest.json'),
    ).toBe('https://github.com/xiaojianc916/poietica'))
  it('rejects another origin', () =>
    expect(manifestBase('https://example.com/x/releases/latest/download/latest.json')).toBeNull())
  it('rejects another route', () =>
    expect(manifestBase('https://github.com/x/y/releases/download/v1/latest.json')).toBeNull())
})
