import { describe, expect, test } from 'bun:test'
import { waitFor } from '@poietica/test-kit'
import type { CoreModule } from '../module'
import { makeKernel } from './helpers'

describe('启动对账：jobs / workflows', () => {
  test('模块登记的 job handler 与 workflow handler 在启动时接上', async () => {
    const jobs: unknown[] = []
    const resumed: string[] = []
    const module: CoreModule = {
      id: 'recon',
      setup(ctx) {
        ctx.jobHandlers.register('test.job', (payload) => {
          jobs.push(payload)
        })
        ctx.jobs.enqueue({ kind: 'test.job', payload: { n: 1 } })
        ctx.workflows.start({ id: 'wf-1', kind: 'test.flow', step: 'one' })
        ctx.workflowHandlers.register('test.flow', (record) => {
          resumed.push(record.id)
          ctx.workflows.advance(record.id, { step: 'two', state: 'done' })
        })
      },
    }
    const h = await makeKernel([module])
    await waitFor(() => jobs.length === 1 && resumed.length === 1)
    expect(jobs).toEqual([{ n: 1 }])
    expect(resumed).toEqual(['wf-1'])
    expect(h.kernel.services).toBeDefined()
    await h.dispose()
  })

  test('同一个 kind 两个主人：启动直接失败', async () => {
    const module = (id: string): CoreModule => ({
      id,
      setup(ctx) {
        ctx.jobHandlers.register('same.job', () => undefined)
      },
    })
    const h = await makeKernel([module('a'), module('b')])
    expect(h.failed).toBe(true)
    await h.dispose()
  })
})
