import { describe, expect, it } from 'bun:test'
import { PYTHON_ASSET_SHA256, PYTHON_DOWNLOAD_URLS, PYTHON_RELEASE_TAG, PYTHON_VERSION } from '../release'
import { markerMatches, onReadyPlan, statusOf } from '../status'

describe('PY-7: release.test.ts', () => {
  it('PYTHON_ASSET_SHA256 是 64 位小写十六进制', () => {
    expect(PYTHON_ASSET_SHA256).toMatch(/^[a-f0-9]{64}$/)
  })

  /*
   * 占位值（64 个 0 / 空串）也满足上面那条正则，却会让每一次真实安装都在校验处失败。
   * 这一条把它钉死：`bun run python:pin` 没跑过，CI 就得红。
   */
  it('PYTHON_ASSET_SHA256 不是占位值（python:pin 已跑过）', () => {
    expect(PYTHON_ASSET_SHA256).not.toBe('0'.repeat(64))
    expect(PYTHON_ASSET_SHA256.length).toBe(64)
    expect(new Set(PYTHON_ASSET_SHA256).size).toBeGreaterThan(1)
  })

  it('PYTHON_DOWNLOAD_URLS 中包含 %2B', () => {
    expect(PYTHON_DOWNLOAD_URLS.some((url) => url.includes('%2B'))).toBe(true)
  })

  it('PYTHON_RELEASE_TAG 与 PYTHON_VERSION 非空', () => {
    expect(PYTHON_RELEASE_TAG.length).toBeGreaterThan(0)
    expect(PYTHON_VERSION.length).toBeGreaterThan(0)
  })
})

describe('statusOf', () => {
  it('ready 时 version 是 PYTHON_VERSION', () => {
    const s = statusOf('ready', null, null, 'C:pythonpython.exe')
    expect(s.state).toBe('ready')
    expect(s.version).toBe(PYTHON_VERSION)
    expect(s.interpreter).toBe('C:pythonpython.exe')
    expect(s.error).toBeNull()
  })

  it('failed 时 error 非空', () => {
    const s = statusOf('failed', null, { code: 'python.download_failed', message: '网络错误' })
    expect(s.state).toBe('failed')
    expect(s.error?.code).toBe('python.download_failed')
  })
})

describe('markerMatches', () => {
  it('标记文件 tag 不一致 → false', () => {
    expect(markerMatches({ tag: 'wrong', version: PYTHON_VERSION, sha256: PYTHON_ASSET_SHA256, installedAt: 0 })).toBe(
      false,
    )
  })

  it('标记文件完全匹配 → true', () => {
    expect(
      markerMatches({ tag: PYTHON_RELEASE_TAG, version: PYTHON_VERSION, sha256: PYTHON_ASSET_SHA256, installedAt: 0 }),
    ).toBe(true)
  })

  it('null → false', () => {
    expect(markerMatches(null)).toBe(false)
  })
})

describe('onReadyPlan（07 页 §13C 的 onReady 判据）', () => {
  const marker = { tag: PYTHON_RELEASE_TAG, version: PYTHON_VERSION, sha256: PYTHON_ASSET_SHA256, installedAt: 1 }

  it('标记与 exe 都对 → ready，并把解释器路径再报一次', () => {
    const plan = onReadyPlan({
      marker,
      exeExists: true,
      interpreter: 'C:\\tools\\python\\python.exe',
      pythonDir: 'C:\\tools\\python',
    })
    expect(plan.ready).toBe(true)
    expect(plan.exePath).toBe('C:\\tools\\python\\python.exe')
    expect(plan.clearInterpreter).toBe(false)
  })

  it('PY-6：标记的 tag 不一致 → absent；引 Path 指向我们目录时清空', () => {
    const plan = onReadyPlan({
      marker: { ...marker, tag: 'wrong' },
      exeExists: true,
      interpreter: 'C:\\tools\\python\\python.exe',
      pythonDir: 'C:\\tools\\python',
    })
    expect(plan.ready).toBe(false)
    expect(plan.clearInterpreter).toBe(true)
  })

  it('解释器指向别处（用户自己的 Python）→ 不动它', () => {
    const plan = onReadyPlan({
      marker: null,
      exeExists: false,
      interpreter: 'C:\\Python312\\python.exe',
      pythonDir: 'C:\\tools\\python',
    })
    expect(plan.ready).toBe(false)
    expect(plan.clearInterpreter).toBe(false)
  })

  it('标记对但 exe 不在 → absent', () => {
    const plan = onReadyPlan({
      marker,
      exeExists: false,
      interpreter: null,
      pythonDir: 'C:\\tools\\python',
    })
    expect(plan.ready).toBe(false)
    expect(plan.clearInterpreter).toBe(false)
  })
})
