import './omp-home'

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { OMP_VERSION, OMP_VERSION_UNKNOWN } from '../omp-version'

/*
 * 版本号只有一个产地（catalog），所以这里钉的是**取版本那条路**，不是某个版本的值：
 * 真值会随升级变，判据不该跟着变。
 */
describe('OMP_VERSION', () => {
  /** 随包安装的那份 omp 的版本：与解析路径无关的独立算法，用来对照 */
  function installedVersion(): string {
    const entry = Bun.resolveSync('@oh-my-pi/pi-coding-agent', import.meta.dir)
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(path.dirname(entry)), 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof pkg.version === 'string' ? pkg.version : ''
  }

  test('解析到的是随包那份 omp 的版本，不是哨兵', () => {
    const installed = installedVersion()
    expect(installed).not.toBe('')
    // 生产由构建期注入（apps/core/scripts/build.ts）；这条用例跑的是源码运行那条路
    expect(OMP_VERSION).toBe(installed)
    expect(OMP_VERSION).not.toBe(OMP_VERSION_UNKNOWN)
    // 必须是 x.y.z 形状的版本号，不是空串、不是路径
    expect(OMP_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('解析到的包里有 omp 的 package.json（路径退两级是对的）', () => {
    const entry = Bun.resolveSync('@oh-my-pi/pi-coding-agent', import.meta.dir)
    expect(existsSync(path.join(path.dirname(path.dirname(entry)), 'package.json'))).toBe(true)
    // 退两级必须是包根：同级能看到 src 与 dist
    const pkgRoot = path.dirname(path.dirname(entry))
    expect(existsSync(path.join(pkgRoot, 'src'))).toBe(true)
  })
})
