import '../../__tests__/omp-home'

import { describe, expect, test } from 'bun:test'
import { noopLogger } from '@poietica/foundation'
import { OmpPluginsPort } from '../plugins'

const cwd = process.cwd()

function makePort(): OmpPluginsPort {
  return new OmpPluginsPort({ cwd, logger: noopLogger })
}

describe('PluginsPort', () => {
  test('list 交回数组，元素形状合契约（离线：没有装过就是空表）', async () => {
    const plugins = await makePort().list()
    expect(Array.isArray(plugins)).toBe(true)
    for (const plugin of plugins) {
      expect(typeof plugin.id).toBe('string')
      expect(typeof plugin.name).toBe('string')
      expect(typeof plugin.version).toBe('string')
      expect(typeof plugin.enabled).toBe('boolean')
    }
  })

  test('marketplace(null) 用 omp 自己的市场源；查询串大小写不敏感地过滤', async () => {
    const port = makePort()
    const all = await port.marketplace(null)
    expect(Array.isArray(all)).toBe(true)
    const filtered = await port.marketplace('NO-SUCH-PLUGIN-NAME-XYZ')
    expect(filtered).toEqual([])
  })

  test('install 要求 name@marketplace 形状的 id，形状不对时如实拒绝', async () => {
    await expect(makePort().install('no-marketplace-part')).rejects.toMatchObject({
      code: 'kernel.invalid_params',
    })
  })

  test('uninstall / setEnabled 对没装过的 id 如实抛 AppError（不静默成功）', async () => {
    const port = makePort()
    await expect(port.uninstall('no-such-plugin-xyz@no-such-marketplace')).rejects.toMatchObject({
      code: expect.any(String),
    })
    await expect(port.setEnabled('no-such-plugin-xyz@no-such-marketplace', true)).rejects.toMatchObject({
      code: expect.any(String),
    })
  })
})
