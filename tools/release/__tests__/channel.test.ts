import { describe, expect, it } from 'bun:test'
import { channelFault, type Manifest } from '../verify-channel.ts'

const healthy: Manifest = {
  version: '0.2.2',
  platforms: { 'windows-x86_64-nsis': { url: 'https://example/update.zip', signature: 'sig' } },
}

describe('channelFault', () => {
  it('accepts a complete official updater manifest', () =>
    expect(channelFault(healthy, 'v0.2.2')).toBeNull())
  it('rejects a version mismatch', () =>
    expect(channelFault({ ...healthy, version: '0.2.1' }, 'v0.2.2')).toContain('0.2.1'))
  it('rejects an unsigned artifact', () =>
    expect(
      channelFault(
        { version: '0.2.2', platforms: { 'windows-x86_64-nsis': { url: 'x' } } },
        'v0.2.2',
      ),
    ).toContain('incomplete'))
})
