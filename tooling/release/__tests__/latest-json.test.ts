import { describe, expect, it } from 'bun:test'
import { downloadUrl, manifestFault } from '../latest-json'

const manifest = {
  version: '0.2.10',
  path: 'Poietica_0.2.10_x64-setup.exe',
  sha512: 'AbCd==',
  files: [{ url: 'Poietica_0.2.10_x64-setup.exe', sha512: 'AbCd==' }],
}

const INSTALLER = 'Poietica_0.2.10_x64-setup.exe'

/* electron-builder 写的那份原样通过；缺清单、版本不对、指向别的安装包、没有校验和都必须报出来（客户端会去拉不存在的地址）。 */
describe('manifestFault', () => {
  it('本版构建写出的 latest.yml 通过', () => {
    expect(manifestFault(manifest, 'v0.2.10', INSTALLER)).toBeNull()
  })

  it('缺清单 / 版本不符 / 指向别的安装包 / 没有 sha512 各自报出原因', () => {
    expect(manifestFault(undefined, 'v0.2.10', INSTALLER)).toContain('latest.yml 缺失')
    expect(manifestFault(manifest, 'v0.2.11', 'Poietica_0.2.11_x64-setup.exe')).toContain('不是 0.2.11')
    expect(manifestFault(manifest, 'v0.2.10', 'Poietica_0.2.10_x64-other.exe')).toContain(
      '不是 Poietica_0.2.10_x64-other.exe',
    )
    expect(manifestFault({ ...manifest, sha512: '' }, 'v0.2.10', INSTALLER)).toContain('sha512')
  })
})

describe('downloadUrl', () => {
  it('points at the tagged asset under the repository base', () => {
    expect(downloadUrl('https://github.com/xiaojianc916/poietica', 'v0.2.10', 'Poietica_0.2.10_x64-setup.exe')).toBe(
      'https://github.com/xiaojianc916/poietica/releases/download/v0.2.10/Poietica_0.2.10_x64-setup.exe',
    )
  })
})
