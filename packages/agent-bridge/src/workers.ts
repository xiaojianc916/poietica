/*
 * worker 选择器的分发。
 *
 * 不自己写那张表：SDK 的 cli.ts 里有一份完整的（14 个选择器，含 tiny / stats-sync /
 * tab / js-eval / computer / stt / tts / blob-broker / lsp-mux …），手抄一份就是第二个
 * 事实，SDK 加一个选择器我们就少一个。
 *
 * cli.ts 的入口守卫是 `isProcessEntry || !Bun.isMainThread`：worker 线程里
 * `Bun.isMainThread` 为假，于是 import 它会照常跑 runCli —— 这正是 SDK 自己的
 * 编译产物走的路（worker 用同一份 cli.js 重新进场）。主线程里两条都不成立，
 * 所以常规的 stdio 服务进程 import 它不会有副作用。
 *
 * 迟到这里才 import：那张表把 CLI 的整片图（模式、命令、TUI）拉进来，常规启动
 * 不该为它付钱 —— 只有 worker 选择器在场时才需要。
 */
export async function runWorkerSelector(selector: string): Promise<void> {
  const { runCli } = await import('@oh-my-pi/pi-coding-agent/cli')

  await runCli([selector])
}
