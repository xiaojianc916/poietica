import { parentPort } from 'node:worker_threads'
import { declareWorkerHostEntry, installWorkerInbox, isWorkerHostSelector } from '@oh-my-pi/pi-utils/worker-host'

// omp 知识 #1：declareWorkerHostEntry() 必须在模块顶层同步调用；worker 分支先同步 installWorkerInbox(parentPort)，
// 再 runCli([selector])。顺序反了会丢掉父线程的 init 握手，worker 永远等不到任务。
declareWorkerHostEntry()

export type ProcessMode = 'serve' | 'worker' | 'browser-relay'

/** 永不兑现：worker 与 relay 都由 omp 自己接管生命周期（12 页 §4.4） */
function never(): Promise<never> {
  return new Promise<never>(() => undefined)
}

/**
 * Core 的参数分派。argv[2] 是模式（04 页 §3.2）：bun 编译版的 argv[1] 是内嵌入口。
 * 本文件只允许静态 import @oh-my-pi/pi-utils/worker-host（它不触发目录解析与 .env 加载），
 * 其它 omp 模块一律在分支里动态 import。
 */
export async function dispatchProcessMode(argv: readonly string[] = process.argv): Promise<'serve' | never> {
  const selector = argv[2]
  if (selector === undefined) {
    process.stderr.write('未知模式：缺少参数\n')
    process.exit(2)
  }
  if (isWorkerHostSelector(selector)) {
    if (parentPort !== null) installWorkerInbox(parentPort)
    const cli = await import('@oh-my-pi/pi-coding-agent/cli')
    void cli.runCli([selector])
    return never()
  }
  if (selector === 'browser-relay') {
    // omp 知识 #2：browser-relay 子命令走 runCli(argv)
    const cli = await import('@oh-my-pi/pi-coding-agent/cli')
    void cli.runCli(argv.slice(2))
    return never()
  }
  if (selector === 'serve') return 'serve'
  process.stderr.write(`未知模式：${selector}\n`)
  process.exit(2)
}
