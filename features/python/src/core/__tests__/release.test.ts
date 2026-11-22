import { describe, expect, it } from 'bun:test'
import type { PythonCandidate } from '../detect'
import {
  MIN_PYTHON_VERSION,
  PYTHON_DOWNLOAD_URLS,
  PYTHON_INSTALLER,
  PYTHON_INSTALLER_SHA256,
  PYTHON_VERSION,
} from '../release'
import { chooseCandidate, isSupported, statusOf } from '../status'

describe('PY-7 钉住的发布物', () => {
  /* 占位值（64 个 0）也满足那条正则，却会让每一次真实安装都在校验处失败。这一条把它钉死：
   * `bun run python:pin` 没跑过，CI 就得红。 */
  it('PYTHON_INSTALLER_SHA256 是 64 位小写十六进制，且不是占位值', () => {
    expect(PYTHON_INSTALLER_SHA256).toMatch(/^[a-f0-9]{64}$/)
    expect(PYTHON_INSTALLER_SHA256).not.toBe('0'.repeat(64))
    expect(new Set(PYTHON_INSTALLER_SHA256).size).toBeGreaterThan(1)
  })

  it('下载地址都指向同一个官方安装包，且先镜像后 python.org', () => {
    expect(PYTHON_INSTALLER).toBe(`python-${PYTHON_VERSION}-amd64.exe`)
    expect(PYTHON_DOWNLOAD_URLS.length).toBeGreaterThanOrEqual(2)
    for (const url of PYTHON_DOWNLOAD_URLS) expect(url.endsWith(PYTHON_INSTALLER)).toBe(true)
    expect(PYTHON_DOWNLOAD_URLS.at(-1)).toContain('python.org')
  })

  it('最低版本低于当前钉住版本', () => {
    expect(isSupported(PYTHON_VERSION)).toBe(true)
    expect(isSupported(MIN_PYTHON_VERSION)).toBe(true)
    expect(isSupported('3.10.14')).toBe(false)
    expect(isSupported('3.11.0')).toBe(true)
  })
})

describe('statusOf', () => {
  it('ready / outdated 带上版本与解释器', () => {
    const ready = statusOf('ready', { version: '3.15.2', interpreter: 'C:\\Python315\\python.exe' })
    expect(ready).toMatchObject({
      state: 'ready',
      version: '3.15.2',
      interpreter: 'C:\\Python315\\python.exe',
      progress: null,
      error: null,
    })

    const outdated = statusOf('outdated', { version: '3.9.13', interpreter: 'C:\\Python39\\python.exe' })
    expect(outdated.state).toBe('outdated')
    expect(outdated.version).toBe('3.9.13')
  })

  it('failed 时 error 非空', () => {
    const failed = statusOf('failed', { error: { code: 'python.download_failed', message: '网络错误' } })
    expect(failed.state).toBe('failed')
    expect(failed.error?.code).toBe('python.download_failed')
  })
})

describe('chooseCandidate', () => {
  const candidate = (path: string, version: string): PythonCandidate => ({
    path,
    version,
    managed: false,
    default: false,
    source: 'launcher',
  })

  const current = candidate('C:\\venv\\Scripts\\python.exe', '3.12.8')
  const system = candidate('C:\\Python315\\python.exe', '3.15.2')
  const tooOld = candidate('C:\\Python39\\python.exe', '3.9.13')

  it('已配置且达标 → 尊重它，不被系统里的新版本顶掉', () => {
    expect(chooseCandidate({ candidates: [system, current], current: current.path, preferDetected: false })).toBe(
      current,
    )
  })

  it('已配置但版本过低 → 换到探测结果的第一顺位', () => {
    expect(chooseCandidate({ candidates: [system, tooOld], current: tooOld.path, preferDetected: false })).toBe(system)
  })

  it('刚装完 → 直接取第一顺位', () => {
    expect(chooseCandidate({ candidates: [system, current], current: current.path, preferDetected: true })).toBe(system)
  })

  it('没有配置 → 第一顺位；一个都没有 → null', () => {
    expect(chooseCandidate({ candidates: [system], current: null, preferDetected: false })).toBe(system)
    expect(chooseCandidate({ candidates: [], current: null, preferDetected: false })).toBeNull()
  })
})
