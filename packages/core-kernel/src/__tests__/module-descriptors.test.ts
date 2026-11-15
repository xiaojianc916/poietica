import { describe, expect, test } from 'bun:test'
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
