import { describe, expect, test } from 'bun:test'
import { createCoreHarness } from '@poietica/core-kernel/testing'
import { createFakeEngine } from '@poietica/engine-testkit'
import { fakeClock } from '@poietica/test-kit'
import { workbuddyContract } from '../../contract'
import workbuddy from '../index'

describe('WorkBuddy core 模块', () => {
  test('装配后可读快照；没有账号时反代是 missing', async () => {
    const clock = fakeClock()
    const h = await createCoreHarness({
      modules: [workbuddy],
      engine: createFakeEngine({ clock }),
      clock,
    })
    const snapshot = await h.client(workbuddyContract).call('workbuddy.snapshot', {})
    expect(snapshot.accounts).toEqual([])
    expect(snapshot.proxy).toMatchObject({ enabled: true, running: false, providerState: 'missing' })
    expect(snapshot.autoCheckin).toBe(true)
    await h.dispose()
  })
})
