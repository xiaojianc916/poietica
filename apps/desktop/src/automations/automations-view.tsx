import { useAgentControls } from '@poietica/agent-ui'
import { AutomationsSurface } from '@poietica/automations'

import { automationStore } from './automation-runtime'

/**
 * 自动化那一格与 agent 可调项的交界。
 *
 * @poietica/automations 不认识 agent —— 它与 @poietica/agent-ui 同层（见
 * tools/architecture 的 layers 表），横向依赖只会是环的前身。所以「有哪些项可选、
 * 每一项当前是什么」由这一层读出来、当数据交下去，那一层只认识这份数据的形状。
 *
 * 必须是一个组件，不能写成 assistant-wiring 里那个箭头：surfaces 里的渲染器是被
 * SurfaceHost 当普通函数调用的，在里面调 hook 会挂到别人的 fiber 上。
 *
 * 只取表，不取 failure/retry：这一屏存的是「以后每次到期用什么」，它把人没动过的
 * 项落成 agent 此刻报的 current（见 AutomationEditor 的 resolve）。
 */
export function AutomationsView() {
  const { controls } = useAgentControls()

  return <AutomationsSurface controls={controls} store={automationStore} />
}
