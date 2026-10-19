import { defineHostModule } from '@poietica/host-kernel'
import { WIDGET_ASSET_HOST } from '../contract'
import { createWidgetShellHandler } from './widget-shell'

/** widgets 的 Host 半边（审查 R-18）：在资源协议下挂组件外壳文档 poietica-asset://widget/…。没有 owner='host' 的方法，不声明 contract。 */
export default defineHostModule({
  id: 'widgets',
  setup(ctx) {
    ctx.assets.register(WIDGET_ASSET_HOST, createWidgetShellHandler())
  },
})
