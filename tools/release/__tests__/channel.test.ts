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
})
