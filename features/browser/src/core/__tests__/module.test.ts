import { describe, expect, test } from 'bun:test'
import { createCoreHarness } from '@poietica/core-kernel/testing'
import { createFakeEngine } from '@poietica/engine-testkit'
import { browserContract } from '../../contract'
import browser from '../index'

describe('browser core（relay 端口转交）', () => {
  test('BR-12 引擎报的 relay 端口原样转给 Host；端口之外什么都不给（口令走文件）', async () => {
    const engine = Object.assign(createFakeEngine(), { browserRelay: () => ({ port: 4321 }) })
    const h = await createCoreHarness({ modules: [browser], engine })
    expect(await h.client(browserContract).call('browser.relayEndpoint', {})).toEqual({ port: 4321 })
    await h.dispose()
  })

  test('BR-12 引擎这一次没开 relay（替身、探针）→ port: null，Host 不去连', async () => {
    const h = await createCoreHarness({ modules: [browser], engine: createFakeEngine() })
    expect(await h.client(browserContract).call('browser.relayEndpoint', {})).toEqual({ port: null })
    await h.dispose()
  })
})
