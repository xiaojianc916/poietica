import { describe, expect, it } from 'bun:test'
import { channelFault, type Manifest } from '../verify-channel.ts'

const healthy: Manifest = {
  version: '0.2.2',
  platforms: {
    'windows-x86_64': {
      url: 'https://github.com/xiaojianc916/poietica/releases/download/v0.2.2/Poietica.exe',
      signature: 'sig',
    },
  },
}

describe('channelFault', () => {
  it('accepts a complete official updater manifest', () => {
    expect(channelFault(healthy, 'v0.2.2')).toBeNull()
  })

  it('rejects a version mismatch', () => {
    expect(channelFault({ ...healthy, version: '0.2.1' }, 'v0.2.2')).toContain('0.2.1')
  })

  it('rejects an unsigned artifact', () => {
    expect(
      channelFault(
        {
          version: '0.2.2',
          platforms: { 'windows-x86_64': { url: 'https://example.com/update.exe' } },
        },
        'v0.2.2',
      ),
    ).toContain('incomplete')
  })

  it('rejects an artifact from another release', () => {
    expect(
      channelFault(
        {
          version: '0.2.2',
          platforms: {
            'windows-x86_64': {
              url: 'https://github.com/x/y/releases/download/v0.2.1/update.exe',
              signature: 'sig',
            },
          },
        },
        'v0.2.2',
      ),
    ).toContain('outside')
  })

  /*
   * 旧自研更新器的清单没有 platforms：v0.2.2 的 feed 曾是这个形状，
   * 新客户端解析失败报 "the `url` field was not set"。feed 必须带 platforms。
   */
  it('rejects the legacy custom-updater manifest without platforms', () => {
    expect(
      channelFault(
        {
          version: '0.2.2',
          payloadHash: '78d82efee36157b6e2da68a5d9963b1dda26723248635e22557dd33942c55118',
          full: {
            url: 'https://github.com/xiaojianc916/poietica/releases/download/v0.2.2/poietica-0.2.2.payload.zst',
            signature: 'sig',
          },
          patches: [],
        } as Manifest,
        'v0.2.2',
      ),
    ).toContain('incomplete')
  })

  /* 过渡期 feed 双语并存：多出来的旧字段不能绊住新客户端。 */
  it('accepts a bilingual manifest that still carries legacy fields', () => {
    expect(channelFault({ ...healthy, payloadHash: 'abc' } as Manifest, 'v0.2.2')).toBeNull()
  })
})
