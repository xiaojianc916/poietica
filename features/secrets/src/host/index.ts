import { defineHostModule } from '@poietica/host-kernel'
import { safeStorage } from 'electron'
import { secretsContract } from '../contract'
import { safeStorageCipher } from './safe-storage'
import { createSecretVault } from './vault'

export default defineHostModule({
  id: 'secrets',
  contract: secretsContract,
  setup(ctx) {
    const vault = createSecretVault({
      file: ctx.layout.secretsFile,
      cipher: safeStorageCipher(safeStorage),
      logger: ctx.logger,
    })
    ctx.rpc.handle('secrets.lease', async ({ namespace }) => ({ entries: await vault.lease(namespace) }))
    ctx.rpc.handle('secrets.put', async ({ namespace, key, value }) => {
      await vault.put(namespace, key, value)
      ctx.logger.info('secret stored', { namespace, key })
      return {}
    })
    ctx.rpc.handle('secrets.delete', async ({ namespace, key }) => {
      await vault.delete(namespace, key)
      ctx.logger.info('secret deleted', { namespace, key })
      return {}
    })
  },
})
