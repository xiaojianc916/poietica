import { parentPort } from 'node:worker_threads'
import { declareWorkerHostEntry, isWorkerHostSelector } from '@oh-my-pi/pi-utils/worker-host'
import { type EarlyMessagePort, holdEarlyMessages, ompCliSelfDispatches } from './worker-dispatch'

/*
 * omp 知识 #1（审查 R-20-2 修订）：
 * - declareWorkerHostEntry() 必须在模块顶层同步调用；
 * - omp 的 cli.ts **会自己派发 worker 选择子**：模块顶层 `isProcessEntry = import.meta.main || process.env.PI_COMPILED === "true"`，
 *   `if (isProcessEntry || !Bun.isMainThread) runCli(process.argv.slice(2))`。编译版（build 里 define 了 PI_COMPILED）与
 *   任何 worker 线程里，import cli 这一下就已经派发了；我们再 runCli 一次 = 同一个 worker 起两份。eval 子进程里两个
 *   JsRuntime 同吃一条 run 消息 → 「Cannot run code while another same-realm JS runtime is running」；broker 子进程里两个
 *   broker 抢同一根命名管道。所以只在 cli **不会**自派发时（开发版的主线程子进程）由我们派发；
 * - worker 线程里父线程 spawn 后立刻发的 init 握手只在入口模块顶层求值结束时冲刷一次。cli 自派发时会自己
 *   installWorkerInbox，但那已在冲刷之后；我们在同步前缀里先挂 `holdEarlyMessages` 接住它，再原样交给 omp 的收件箱。
 */
declareWorkerHostEntry()

export type ProcessMode = 'serve' | 'worker' | 'browser-relay'

/** 永不兑现：worker 与 relay 都由 omp 自己接管生命周期 */
function never(): Promise<never> {
  return new Promise<never>(() => undefined)
}

/**
 * Core 的参数分派。argv[2] 是模式：bun 编译版的 argv[1] 是内嵌入口。
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
    if (parentPort !== null) holdEarlyMessages(parentPort as unknown as EarlyMessagePort)
    const cli = await import('@oh-my-pi/pi-coding-agent/cli')
    if (!ompCliSelfDispatches()) void cli.runCli([selector])
    return never()
  }
  if (selector === 'browser-relay') {
    // omp 知识 #2：browser-relay 子命令走 runCli(argv)；编译版里 cli 已经自己派发过（omp 知识 #1）
    const cli = await import('@oh-my-pi/pi-coding-agent/cli')
    if (!ompCliSelfDispatches()) void cli.runCli(argv.slice(2))
    return never()
  }
  if (selector === 'serve') return 'serve'
  process.stderr.write(`未知模式：${selector}\n`)
  process.exit(2)
}
