import { defineHostModule } from '@poietica/host-kernel'
import { INTELLIGENT_UI_ASSET_HOST } from '../contract'
import { createShellHandler } from './shell'

/** intelligent-ui 的 Host 半边：在资源协议下挂外壳文档 poietica-asset://intelligent-ui/…。没有 owner='host' 的方法。 */
export default defineHostModule({
  id: 'intelligent-ui',
  setup(ctx) {
    ctx.assets.register(INTELLIGENT_UI_ASSET_HOST, createShellHandler())
  },
})
