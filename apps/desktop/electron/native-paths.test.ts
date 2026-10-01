import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { nativeCandidates } from './native-paths'

/*
 * 原生库的落点。这条路径错过一次：打包后 extraResources 把库放在 resources/native/，
 * 而加载器按 asarUnpack 那条路找 app.asar.unpacked/native/ —— 目录是空的，用户装上
 * 一启动就是「原生库加载失败」。它不可测才会漏，所以这里把入参摊开直接钉住。
 */

const packaged = {
  override: undefined,
  isPackaged: true,
  resourcesPath: 'C:\\App\\resources',
  appPath: 'C:\\App\\resources\\app.asar',
}

describe('打包后的原生库落点', () => {
  test('找 resources/native，不是 app.asar.unpacked（extraResources 不经 asar）', () => {
    const candidates = nativeCandidates(packaged)

    expect(candidates).toEqual([join('C:\\App\\resources', 'native', 'poietica.node')])
    expect(candidates[0]).not.toContain('app.asar.unpacked')
  })
})

describe('开发期的原生库落点', () => {
  test('两种启动深度都给出候选：electron-vite 三层、electron . 两层', () => {
    const candidates = nativeCandidates({
      override: undefined,
      isPackaged: false,
      resourcesPath: 'C:\\App\\resources',
      appPath: 'D:\\repo\\apps\\desktop',
    })

    /* target/debug 与 target/release 各两条，debug 在前。 */
    expect(candidates).toHaveLength(4)
    expect(candidates[0]).toContain(join('target', 'debug'))
    expect(candidates[1]).toContain(join('target', 'release'))
    expect(candidates.every((candidate) => candidate.endsWith('poietica.node'))).toBe(true)
  })
})

describe('POIETICA_NATIVE 覆盖', () => {
  test('给了覆盖就只用它，开发期与打包期都一样', () => {
    const override = 'D:\\custom\\poietica.node'

    expect(nativeCandidates({ ...packaged, override })).toEqual([override])
    expect(nativeCandidates({ ...packaged, override, isPackaged: false })).toEqual([override])
  })

  test('空字符串不算覆盖', () => {
    expect(nativeCandidates({ ...packaged, override: '' })).toHaveLength(1)
  })
})
