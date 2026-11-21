/*
 * 首句提交的跨表面交接：入口页提交 -> 线程页挂载是两块表面，焦点与过渡观感都要从这里过一手。
 * 两个区（setup 的 openThread 与 home 的表面）都读这一格，所以放在 ui 根上，与 entry-init.ts 同一层。
 */

/** 提交这一跳的路由过渡类型：主卡片不参与快照，只补输入框/页头/正文。CSS 认领这个名字。 */
export const SUBMIT_TRANSITION_TYPE = 'ui-submit'

/** 请求最多等这么久：线程没按预期挂载（建线程失败、用户立刻换了页面）就作废。 */
const HANDOFF_TTL_MS = 1500

let focusAt: number | null = null
let submitAt: number | null = null

export function rememberComposerFocus(): void {
  focusAt = performance.now()
}

export function takeComposerFocus(): boolean {
  const at = focusAt
  focusAt = null
  return at !== null && performance.now() - at <= HANDOFF_TTL_MS
}

/** 标记「这一次导航就是首句提交」，新表面据此在快照之后隐藏真元素、由过渡图接管。 */
export function rememberSubmitHandoff(): void {
  submitAt = performance.now()
}

export function takeSubmitHandoff(): boolean {
  const at = submitAt
  submitAt = null
  return at !== null && performance.now() - at <= HANDOFF_TTL_MS
}
