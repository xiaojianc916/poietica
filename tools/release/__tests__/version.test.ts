import { describe, expect, it } from 'bun:test'
import { bumped, SEMVER, workspaceVersion } from '../version.ts'

describe('bumped', () => {
  it('increments each segment independently', () => {
    expect(bumped('1.2.3')).toEqual({ major: '2.0.0', minor: '1.3.0', patch: '1.2.4' })
  })

  it('strips a prerelease tail before incrementing', () => {
    expect(bumped('0.2.2-rc.1').patch).toBe('0.2.3')
  })
})

describe('SEMVER', () => {
  it('accepts release and prerelease versions', () => {
    expect(SEMVER.test('0.2.2')).toBe(true)
    expect(SEMVER.test('0.2.2-rc.1')).toBe(true)
  })

  it('rejects partial or prefixed versions', () => {
    expect(SEMVER.test('0.2')).toBe(false)
    expect(SEMVER.test('v0.2.2')).toBe(false)
  })
})

describe('workspaceVersion', () => {
  it('reads the [workspace.package] version only', () => {
    const toml = [
      '[package]',
      'name = "other"',
      'version = "9.9.9"',
      '',
      '[workspace.package]',
      'version = "0.2.2"',
      '',
      '[workspace.dependencies]',
      'serde = "1"',
    ].join('\n')

    expect(workspaceVersion(toml)).toBe('0.2.2')
  })

  it('returns undefined without the section', () => {
    expect(workspaceVersion('[package]\nversion = "0.2.2"')).toBeUndefined()
  })
})
