import { describe, expect, it } from 'bun:test'
import { downloadUrl, manifestFault } from '../latest-json'

const manifest = {
  version: '0.2.10',
  path: 'Poietica_0.2.10_x64-setup.exe',
  sha512: 'AbCd==',
  files: [{ url: 'Poietica_0.2.10_x64-setup.exe', sha512: 'AbCd==' }],
}

describe('manifestFault', () => {
  it('accepts the manifest electron-builder wrote for this build', () => {
    expect(manifestFault(manifest, 'v0.2.10', 'Poietica_0.2.10_x64-setup.exe')).toBeNull()
  })

  it('rejects a missing manifest', () => {
    expect(manifestFault(undefined, 'v0.2.10', 'Poietica_0.2.10_x64-setup.exe')).toContain('latest.yml 缺失')
  })

  it('rejects a version mismatch', () => {
    expect(manifestFault(manifest, 'v0.2.11', 'Poietica_0.2.11_x64-setup.exe')).toContain('不是 0.2.11')
  })

  it('rejects a manifest pointing at another installer', () => {
    expect(manifestFault(manifest, 'v0.2.10', 'Poietica_0.2.10_x64-other.exe')).toContain(
      '不是 Poietica_0.2.10_x64-other.exe',
    )
  })

  it('rejects a manifest without an integrity digest', () => {
    expect(manifestFault({ ...manifest, sha512: '' }, 'v0.2.10', 'Poietica_0.2.10_x64-setup.exe')).toContain('sha512')
  })
})

describe('downloadUrl', () => {
  it('points at the tagged asset under the repository base', () => {
    expect(downloadUrl('https://github.com/xiaojianc916/poietica', 'v0.2.10', 'Poietica_0.2.10_x64-setup.exe')).toBe(
      'https://github.com/xiaojianc916/poietica/releases/download/v0.2.10/Poietica_0.2.10_x64-setup.exe',
    )
  })
})
