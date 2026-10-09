/**
 * 最后兜底通道：日志系统不可用时唯一允许写 console 的地方（biome.json 按精确路径豁免 noConsole）。
 *
 * 只给三类场景调用：启动早期还没有 Logger、logger 初始化失败、致命错误退出前。
 * 其它任何地方要输出，走 `Logger` / `Logger.child()`；渲染层走 ui-kernel 的 UiLogging。
 */
export function lastResort(message: string, error?: unknown): void {
  const detail = error === undefined ? '' : ` ${error instanceof Error ? error.message : String(error)}`
  console.error(`[poietica:last-resort] ${message}${detail}`)
}
