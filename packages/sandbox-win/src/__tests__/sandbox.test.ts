import { describe, expect, test } from 'bun:test'
import { isSandboxedChild, type SandboxedChild, sandboxSelfCheck, spawnSandboxed } from '../index'

describe('sandbox-win', () => {
  test('off 直接放行；restricted 明确报未实现，不静默降级', async () => {
    expect(await sandboxSelfCheck('off')).toEqual({ ok: true, level: 'off', reason: null })
    const restricted = await sandboxSelfCheck('restricted')
    expect(restricted.ok).toBe(false)
    expect(restricted.reason).toContain('尚未实现')
  })

  test('L1：把进程放进 Job，自检通过', async () => {
    if (process.platform !== 'win32') return
    const check = await sandboxSelfCheck('job')
    expect(check).toEqual({ ok: true, level: 'job', reason: null })
  })

  test('L1：terminateSandbox 结束整个 Job', async () => {
    if (process.platform !== 'win32') return
    const child = spawnSandboxed(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60_000)'],
      { stdio: 'ignore', windowsHide: true },
      { level: 'job' },
    )
    expect(isSandboxedChild(child)).toBe(true)
    const exited = Promise.withResolvers<void>()
    ;(child as SandboxedChild).once('exit', () => exited.resolve())
    ;(child as SandboxedChild).terminateSandbox()
    await exited.promise
    expect((child as SandboxedChild).exitCode !== null || child.signalCode === 'SIGTERM').toBe(true)
  })
})
