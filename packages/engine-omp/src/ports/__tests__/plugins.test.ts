import { describe, expect, test } from 'bun:test'
import { noopLogger } from '@poietica/foundation'
import { OmpPluginsPort } from '../plugins'

const cwd = process.cwd()

function makePort(): OmpPluginsPort {
  return new OmpPluginsPort({ cwd, logger: noopLogger })
}

describe('PluginsPort', () => {
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
