import { describe, expect, it } from 'bun:test'
import { channelArtifacts, channelFault, type Manifest } from '../verify-channel.ts'

const HASH_64 = 'a'.repeat(64)

const healthy: Manifest = {
  version: '0.2.2',
  payloadHash: HASH_64,
  full: { url: 'https://example/full.zst', signature: 'sig-full' },
  patches: [
    {
      fromHash: 'b'.repeat(64),
      url: 'https://example/patch.zst',
      signature: 'sig-patch',
    },
  ],
}

describe('channelFault', () => {
  it('accepts a consistent channel', () => {
    expect(channelFault(healthy, 'v0.2.2')).toBeNull()
  })

  it('strips the v prefix from the tag before comparing', () => {
    expect(channelFault(healthy, '0.2.2')).toBeNull()
  })

  it('reports a version mismatch before anything else', () => {
    expect(channelFault({ ...healthy, version: '0.2.1' }, 'v0.2.2')).toContain('0.2.1')
  })

  it('rejects a missing or short payload hash', () => {
    expect(channelFault({ ...healthy, payloadHash: 'short' }, 'v0.2.2')).toContain('payload hash')

    const { payloadHash: _omitted, ...withoutHash } = healthy
    expect(channelFault(withoutHash, 'v0.2.2')).toContain('payload hash')
  })

  it('reports an artifact without a signature', () => {
    const broken: Manifest = {
      ...healthy,
      full: { url: 'https://example/full.zst' },
    }

    expect(channelFault(broken, 'v0.2.2')).toBe('full is incomplete')
  })

  it('reports a patch artifact without a url', () => {
    const broken: Manifest = {
      ...healthy,
      patches: [{ fromHash: 'b'.repeat(64), signature: 'sig-patch' }],
    }

    expect(channelFault(broken, 'v0.2.2')).toContain('is incomplete')
  })
})

describe('channelArtifacts', () => {
  it('lists the full payload first, then patches', () => {
    const artifacts = channelArtifacts(healthy)

    expect(artifacts.map((entry) => entry.label)).toEqual(['full', `patch from ${'b'.repeat(64)}`])
  })

  it('falls back to an ordinal label when a patch carries no fromHash', () => {
    const artifacts = channelArtifacts({ ...healthy, patches: [{}] })

    expect(artifacts[1]?.label).toBe('patch from #1')
  })
})
