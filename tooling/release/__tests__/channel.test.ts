import { describe, expect, it } from 'bun:test'
import { channelFault } from '../verify-channel'

/*
 * electron-updater 认的 latest.yml 只有三种字段：version、path、sha512。
 * 这三样缺一，客户端要么不更新，要么下一个没校验的包。
 */
describe('channelFault', () => {
  it('accepts the manifest electron-builder publishes', () => {
    expect(
      channelFault({ version: '0.2.2', path: 'Poietica_0.2.2_x64-setup.exe', sha512: 'AbCd==' }, 'v0.2.2'),
    ).toBeNull()
  })

  it('rejects a version mismatch', () => {
    expect(
      channelFault({ version: '0.2.1', path: 'Poietica_0.2.1_x64-setup.exe', sha512: 'AbCd==' }, 'v0.2.2'),
    ).toContain('expected 0.2.2')
  })

  it('rejects a manifest without an installer', () => {
    expect(channelFault({ version: '0.2.2', sha512: 'AbCd==' }, 'v0.2.2')).toContain('no installer or no sha512')
  })

  it('rejects a manifest without an integrity digest', () => {
    expect(channelFault({ version: '0.2.2', path: 'Poietica_0.2.2_x64-setup.exe' }, 'v0.2.2')).toContain(
      'no installer or no sha512',
    )
  })

  it('rejects an installer that is not an NSIS setup', () => {
    expect(channelFault({ version: '0.2.2', path: 'Poietica-0.2.2.dmg', sha512: 'AbCd==' }, 'v0.2.2')).toContain(
      'not an NSIS setup',
    )
  })
})
