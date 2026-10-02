import { describe, expect, it } from 'bun:test'
import type { PythonKernelStatus } from './python-kernel/gateway'
import { failureText, pythonKernelAction, pythonKernelCopy } from './python-kernel-view'

function status(overrides: Partial<PythonKernelStatus> = {}): PythonKernelStatus {
  return {
    state: 'notInstalled',
    version: null,
    path: null,
    interpreter: null,
    install: { running: false, step: null, percent: null, error: null },
    ...overrides,
  }
}

describe('pythonKernelCopy', () => {
  it('says nothing has been decided yet before the first read lands', () => {
    expect(pythonKernelCopy(null).description).toBe('正在读取本机 Python 内核的状态…')
  })

  it('describes every one of the five states in its own words', () => {
    const states = ['notInstalled', 'installing', 'ready', 'broken', 'unsupported'] as const
    const described = states.map((state) => pythonKernelCopy(status({ state })).description)

    expect(new Set(described).size).toBe(states.length)
  })

  it('reports the version and the path only when the install is ready', () => {
    const path = 'C:/data/tools/python'
    const ready = pythonKernelCopy(status({ state: 'ready', version: '3.12.15', path }))
    const broken = pythonKernelCopy(status({ state: 'broken', version: '3.12.15', path }))

    expect(ready.detail).toBe('Python 3.12.15 · C:/data/tools/python')
    expect(ready.detailLabel).toBe('已安装')
    expect(broken.detail).toBe(path)
  })

  it('translates the steps it knows and keeps the ones it does not', () => {
    const step = (value: string | null) =>
      pythonKernelCopy(
        status({
          state: 'installing',
          install: { running: true, step: value, percent: null, error: null },
        }),
      ).detail

    expect(step('download')).toBe('正在下载解释器（约 22MB）')
    expect(step('whatever')).toBe('正在whatever')
    expect(step(null)).toBe('正在准备解释器')
  })

  it('refuses to paint a state this build does not know', () => {
    const unknown = { ...status(), state: 'melted' } as unknown as PythonKernelStatus

    expect(pythonKernelCopy(unknown).description).toContain('认不出来')
  })

  it('has nothing to report on the two states with nothing to show', () => {
    expect(pythonKernelCopy(status({ state: 'unsupported' })).detail).toBeNull()
    expect(pythonKernelCopy(status({ state: 'notInstalled' })).detail).toBeNull()
  })
})

describe('failureText', () => {
  it('keeps the upstream reason verbatim', () => {
    expect(failureText('下载失败：连接超时')).toBe('安装失败：下载失败：连接超时')
  })

  it('emits exactly one prefix', () => {
    expect(failureText('安装失败：安装失败：runtime failed')).toBe('安装失败：runtime failed')
  })

  it('never renders an empty failure', () => {
    expect(failureText('   ')).toBe('安装失败：上游没有报出失败原因。')
  })
})

describe('pythonKernelAction', () => {
  it('offers install, repair and remove for the three actionable states', () => {
    expect(pythonKernelAction(status({ state: 'notInstalled' })).kind).toBe('install')
    expect(pythonKernelAction(status({ state: 'broken' })).kind).toBe('repair')
    expect(pythonKernelAction(status({ state: 'ready' })).kind).toBe('remove')
  })

  it('names the cost of removing, because it also clears the agent setting', () => {
    expect(pythonKernelAction(status({ state: 'ready' })).warning).toContain('python.interpreter')
  })

  it('offers nothing while the platform has no build or the answer is not in yet', () => {
    expect(pythonKernelAction(null).kind).toBe('none')
    expect(pythonKernelAction(status({ state: 'unsupported' })).kind).toBe('none')
    expect(pythonKernelAction(status({ state: 'installing' })).kind).toBe('none')
  })

  it('offers nothing while a background install is running, whatever the disk says', () => {
    const running = status({
      state: 'notInstalled',
      install: { running: true, step: 'download', percent: null, error: null },
    })

    expect(pythonKernelAction(running).kind).toBe('none')
  })

  it('still lets a failed install be retried', () => {
    const failed = status({
      state: 'broken',
      install: { running: false, step: null, percent: null, error: '解包失败' },
    })

    expect(pythonKernelCopy(failed).failure).toBe('安装失败：解包失败')
    expect(pythonKernelAction(failed).kind).toBe('repair')
  })
})
