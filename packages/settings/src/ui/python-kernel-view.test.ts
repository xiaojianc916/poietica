import { describe, expect, it } from 'bun:test'
import type { PythonKernelStatus } from './python-kernel/gateway'
import {
  failureText,
  pythonKernelAction,
  pythonKernelCopy,
  REMOVE_WARNING,
} from './python-kernel-view'

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

  it('stops repeating the version and the path once the install is ready', () => {
    const path = 'C:/data/tools/python'
    const ready = pythonKernelCopy(status({ state: 'ready', version: '3.12.15', path }))

    /* 就绪不再往行下挂一行绝对路径：装好这件事由横幅说一声，版本与位置的真身在原生侧。 */
    expect(ready.detail).toBeNull()
    expect(ready.detailLabel).toBeNull()
  })

  it('still points at the directory when the install is broken', () => {
    const path = 'C:/data/tools/python'
    const broken = pythonKernelCopy(status({ state: 'broken', version: '3.12.15', path }))

    /* 坏掉时要给人一条能自己去看的线索，所以这一档留着路径。 */
    expect(broken.detail).toBe(path)
    expect(broken.detailLabel).toBe('安装位置')
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

  it('keeps the cost of removing in the dialog instead of on the row', () => {
    /* 行上那句是常驻的，人没要删任何东西也一直摆着 —— 一句总在那儿的警告等于没有警告。
     * 代价只在动手那一下说，也就是确认弹窗。 */
    expect(REMOVE_WARNING).toContain('python.interpreter')
    expect(Object.hasOwn(pythonKernelAction(status({ state: 'ready' })), 'warning')).toBe(false)
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
