import { describe, expect, test } from 'bun:test'
import { defineCoreEvent } from '../events'
import type { CoreModule, CoreModuleDescriptor } from '../module'
import { makeKernel } from './helpers'

const moduleOf = (id: string, dependsOn?: readonly string[]): CoreModule => ({
  id,
  ...(dependsOn === undefined ? {} : { dependsOn }),
  setup: () => undefined,
})

const descriptorOf = (module: CoreModule, tier: number): CoreModuleDescriptor => ({
  id: module.id,
  kind: 'domain',
  processes: ['core'],
  tier,
  module,
})

describe('模块描述符', () => {
  test('描述符覆盖全部模块，按 tier 校验依赖方向', async () => {
    const shared = moduleOf('shared')
    const feature = moduleOf('feature', ['shared'])
    const h = await makeKernel([shared, feature], {
      moduleDescriptors: [descriptorOf(shared, 0), descriptorOf(feature, 1)],
    })
    expect(h.failed).toBe(false)
    await h.dispose()
  })

  test('同级依赖与缺少描述符都在启动期失败', async () => {
    const first = moduleOf('first')
    const second = moduleOf('second', ['first'])
    const same = await makeKernel([first, second], {
      moduleDescriptors: [descriptorOf(first, 1), descriptorOf(second, 1)],
    })
    expect(same.failed).toBe(true)
    await same.dispose()

    const missing = await makeKernel([first], {
      moduleDescriptors: [descriptorOf(second, 1)],
    })
    expect(missing.failed).toBe(true)
    await missing.dispose()
  })
})

describe('运行时描述符', () => {
  test('从契约、事件、迁移与设置声明合成完整视图', async () => {
    const changed = defineCoreEvent<{ id: string }>('feature', 'changed')
    const feature: CoreModule = {
      id: 'feature',
      events: [changed],
      settings: ['feature.enabled'],
      migrations: [
        {
          version: 1,
          name: 'init',
          sql: 'CREATE TABLE feature_items (id TEXT); CREATE INDEX feature_idx ON feature_items (id)',
        },
      ],
      setup: () => undefined,
    }
    const h = await makeKernel([feature], {
      moduleDescriptors: [{ id: 'feature', kind: 'domain', tier: 1, processes: ['core', 'ui'], module: feature }],
    })
    expect(h.failed).toBe(false)
    expect(h.kernel.descriptors[0]).toMatchObject({
      id: 'feature',
      processes: ['core', 'ui'],
      rpc: { methods: [], notifications: [] },
      events: ['feature.changed'],
      tables: ['feature_items'],
      settings: ['feature.enabled'],
    })
    await h.dispose()
  })
})
