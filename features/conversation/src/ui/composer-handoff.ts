/*
 * 首句之后把焦点交回输入框：入口页提交 -> 线程页挂载是两块表面，焦点不会自己跟过去。
 * 两个区（setup 的 openThread 与 home 的表面）都要读这一格，所以放在 ui 根上，与 entry-init.ts 同一层。
 */

/** 请求最多等这么久：线程没按预期挂载（建线程失败、用户立刻换了页面）就作废，别在下一次开对话时抢焦点。 */
const FOCUS_TTL_MS = 1500

let focusAt: number | null = null

export function rememberComposerFocus(): void {
  focusAt = performance.now()
}

export function takeComposerFocus(): boolean {
  const at = focusAt
  focusAt = null
  return at !== null && performance.now() - at <= FOCUS_TTL_MS
}
