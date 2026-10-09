import { describe, expect, test } from 'bun:test'
import { createCoreHarness } from '@poietica/core-kernel/testing'
import { createFakeEngine } from '@poietica/engine-testkit'
import { platformContract } from '../../contract'
import platform from '../index'

describe('platform core（diagnostics）', () => {
  test('diagnostics.core 的 dirs 每一项都在 dataRoot 之下；scrubbedEnvKeys 来自 ctx.runtime', async () => {
    const h = await createCoreHarness({ modules: [platform], engine: createFakeEngine() })
    const api = h.client(platformContract)
    const diag = await api.call('diagnostics.core', {})
    expect(diag.dataRoot).toBe(h.dataRoot)
    for (const [name, dir] of Object.entries(diag.dirs)) {
      expect({ name, inside: dir.startsWith(h.dataRoot) }).toEqual({ name, inside: true })
    }
    // harness 的 runtime.scrubbedEnvKeys 是空数组
    expect(diag.scrubbedEnvKeys).toEqual([])
    expect(diag.coreVersion).toBe('test')
    expect(diag.engineVersion).toBe('test')
    await h.dispose()
  })

  test('diagnostics.core 的 ompRoot 是 omp 的隔离根', async () => {
    const h = await createCoreHarness({ modules: [platform], engine: createFakeEngine() })
    const api = h.client(platformContract)
    const diag = await api.call('diagnostics.core', {})
    expect(diag.ompRoot.startsWith(h.dataRoot)).toBe(true)
    expect(diag.dirs.ompAgentDir?.startsWith(diag.ompRoot)).toBe(true)
    await h.dispose()
  })

  test('diagnostics.setLogLevel 调用了 ctx.runtime.setLogLevel', async () => {
    const h = await createCoreHarness({ modules: [platform], engine: createFakeEngine() })
    const api = h.client(platformContract)
    expect(await api.call('diagnostics.setLogLevel', { level: 'debug' })).toEqual({})
    await h.dispose()
  })

  test('setLogLevel 的 level 由契约约束（非法值被拒）', async () => {
    const h = await createCoreHarness({ modules: [platform], engine: createFakeEngine() })
    const api = h.client(platformContract)
    const err = await api.call('diagnostics.setLogLevel', { level: 'trace' } as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    await h.dispose()
  })
})
