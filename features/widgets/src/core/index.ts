import { defineCoreModule } from '@poietica/core-kernel'
import { registerWidgetTool } from './widget-tool'

/**
 * widgets 的 Core 半边（审查 R-18）：只给 agent 注册 show_widget。工具集在全部 setup 之后冻结，所以必须在 setup 里注册。
 * 没有 RPC 方法，不声明 contract（contract 子入口只放三个进程共用的常量）。
 */
export default defineCoreModule({
  id: 'widgets',
  setup(ctx) {
    registerWidgetTool({ tools: ctx.agentTools })
  },
})
