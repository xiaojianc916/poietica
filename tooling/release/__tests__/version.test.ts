import { describe, expect, it } from 'bun:test'
import {
  bumped,
  compareVersions,
  LOCK_COMMANDS,
  LOCK_FILES,
  packageVersion,
  SEMVER,
  VERSION_FILES,
  VERSION_SOURCE,
} from '../version'

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

  /*
   * semver.org §11 的原例链：数字标识符按数值比、非数字按字典序、数字小于非数字、
   * 前缀更短的更小。发布链拿它判「目标版本必须比当前版本新」，一条比错就会放行
   * 一个装不上的版本号 —— 这条链把整条规则钉成一次全序断言。
   */
  it('orders the canonical precedence chain exactly as semver.org specifies', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let index = 0; index < chain.length; index += 1) {
      for (let other = 0; other < chain.length; other += 1) {
        const expected = Math.sign(index - other)
        expect(Math.sign(compareVersions(chain[index] ?? '', chain[other] ?? ''))).toBe(expected)
      }
    }
  })

  it('treats build metadata as insignificant to precedence', () => {
    expect(compareVersions('1.0.0+build.1', '1.0.0+build.999')).toBe(0)
    expect(compareVersions('1.0.0-rc.1+a', '1.0.0-rc.1+b')).toBe(0)
  })
})

describe('锁文件', () => {
  it('锁文件由包管理器重算，且不与手写声明处混在一起', () => {
    expect([...LOCK_FILES]).toEqual(['bun.lock'])
    expect(LOCK_FILES.filter((file) => (VERSION_FILES as readonly string[]).includes(file))).toEqual([])
    for (const file of LOCK_FILES) {
      expect(LOCK_COMMANDS[file][0]).toBeTruthy()
    }
  })
})

describe('声明处', () => {
  it('唯一来源在列表里，且列表只有仓内包的 package.json', () => {
    expect(VERSION_FILES).toContain(VERSION_SOURCE)
    for (const file of VERSION_FILES) {
      expect(file).toMatch(/^apps\/[^/]+\/package\.json$/)
    }
  })
})

describe('packageVersion', () => {
  it('reads the top-level version', () => {
    expect(packageVersion('{"name":"x","version":"0.5.0"}')).toBe('0.5.0')
  })

  it('does not mistake a nested version for the top-level one', () => {
    /* 依赖里同名的 version 字段不是声明处：顶层没有就是没有。 */
    expect(packageVersion('{"name":"x","dependencies":{"y":{"version":"9.9.9"}}}')).toBeUndefined()
  })

  it('returns undefined instead of throwing on malformed JSON', () => {
    expect(packageVersion('{ not json')).toBeUndefined()
  })
})
