import { describe, expect, it } from 'bun:test'
import { buildManifest, endpointBase } from '../latest-json.ts'

describe('endpointBase', () => {
  it('derives the repo base from the updater endpoint', () => {
    expect(
      endpointBase('https://github.com/xiaojianc916/poietica/releases/latest/download/latest.json'),
    ).toBe('https://github.com/xiaojianc916/poietica')
  })

  it('rejects a non-latest endpoint', () => {
    expect(endpointBase('https://example.com/latest.json')).toBeUndefined()
    expect(endpointBase(undefined)).toBeUndefined()
  })
})

describe('buildManifest', () => {
  it('points windows-x86_64 at the tagged asset', () => {
    const manifest = buildManifest(
      'https://github.com/xiaojianc916/poietica',
      'v0.2.10',
      'Poietica_0.2.10_x64-setup.exe',
      'sig\n',
    )
    expect(manifest.version).toBe('0.2.10')
    expect(manifest.platforms['windows-x86_64']?.url).toBe(
      'https://github.com/xiaojianc916/poietica/releases/download/v0.2.10/Poietica_0.2.10_x64-setup.exe',
    )
    expect(manifest.platforms['windows-x86_64']?.signature).toBe('sig')
  })
})
