import { describe, expect, it } from 'bun:test'
import { bumped, compareVersions, SEMVER, workspaceVersion } from '../version.ts'

describe('bumped', () => {
  it('increments each segment independently', () => {
    expect(bumped('1.2.3')).toEqual({ major: '2.0.0', minor: '1.3.0', patch: '1.2.4' })
  })

  it('strips prerelease and build metadata before incrementing', () => {
    expect(bumped('0.2.2-rc.1+build.7').patch).toBe('0.2.3')
  })
})

describe('SEMVER', () => {
  it('accepts release, prerelease and build versions', () => {
    expect(SEMVER.test('0.2.2')).toBe(true)
    expect(SEMVER.test('0.2.2-rc.1+build.7')).toBe(true)
  })

  it('rejects partial, prefixed and malformed versions', () => {
    expect(SEMVER.test('0.2')).toBe(false)
    expect(SEMVER.test('v0.2.2')).toBe(false)
    expect(SEMVER.test('01.2.3')).toBe(false)
    expect(SEMVER.test('1.2.3-..')).toBe(false)
  })
})

describe('compareVersions', () => {
  it('implements SemVer precedence', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0+one', '1.0.0+two')).toBe(0)
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
