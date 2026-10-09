import { captureLaunchEnv, dispatchProcessMode } from '@poietica/engine-omp/bootstrap'

/**
 * 顶层致命错误的最后通道（06 页 §2.7）：日志系统可能还没有建立，先按 Core 的
 * stderr JSONL 约定写一条 fatal 记录，再以退出码 1 退出 —— Host 会把它当崩溃退避重启。
 */
function fatal(scope: string, error: unknown): void {
  // code 必须带上：06 页 A-K6 的判据是 core.log 里能看到 kernel.unhandled_method
  const code =
    typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : undefined
  const record = {
    ts: Date.now(),
    level: 'error',
    proc: 'core',
    scope,
    msg: 'fatal',
    ...(code === undefined ? {} : { code }),
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  }
  try {
    process.stderr.write(`${JSON.stringify(record)}\n`)
  } catch {
    // stderr 已关闭：没有别的通道了
  }
}

const launchEnv = captureLaunchEnv() // ① 第一条语句：快照启动时就有的环境变量键（必须先于任何 omp 模块求值）
/*
 * 06 页 §2.7：main.ts 顶层注册兜底 —— 任何未捕获异常 / 未处理拒绝写一条 fatal 日志
 * （stderr JSONL，Host 的 CoreLogSink 逐行收进 core.log），随后以退出码 1 退出，
 * Host 按崩溃处理（退避重启；60 秒内超过 5 次进 failed）。
 */
process.on('uncaughtException', (error) => {
  fatal('uncaughtException', error)
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  fatal('unhandledRejection', error)
  process.exit(1)
})
const mode = await dispatchProcessMode() // ② 顶层同步 declareWorkerHostEntry；worker / browser-relay 模式在这里被 omp 接管，永不返回
if (mode === 'serve') {
  const { serve } = await import('./serve') // ③ serve 的全部依赖都动态导入，worker 子进程不会加载它们
  try {
    await serve(launchEnv)
  } catch (error) {
    // 06 页 §2.7：start() 抛出的任何错误由 serve 的外层捕获 → 写一条 fatal 日志 → 退出码 1
    fatal('serve', error)
    process.exit(1)
  }
}
