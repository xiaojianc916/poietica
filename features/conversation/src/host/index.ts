import { defineHostModule } from '@poietica/host-kernel'
import { WIDGET_ASSET_HOST } from '../contract'
import { createWidgetShellHandler } from './widget-shell'

/**
 * conversation 的 host 模块（审查 R-18）：只注册对话内组件的外壳文档。
 * conversation 的契约没有 owner='host' 的方法，所以**不声明 contract**（与 attachments 的 host 同形）。
 */
export default defineHostModule({
  id: 'conversation',
  setup(ctx) {
    ctx.assets.register(WIDGET_ASSET_HOST, createWidgetShellHandler())
  },
})
