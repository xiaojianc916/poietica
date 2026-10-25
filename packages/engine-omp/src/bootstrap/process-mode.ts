import { parentPort } from 'node:worker_threads'
import { declareWorkerHostEntry, isWorkerHostSelector } from '@oh-my-pi/pi-utils/worker-host'
import { MAINTENANCE_MODE, runMaintenance } from './maintenance'
import { withRelayToken } from './relay-token'
import { type EarlyMessagePort, holdEarlyMessages, ompCliSelfDispatches } from './worker-dispatch'

/*
 * omp 知识 #1（审查 R-20-2 修订）：
 * - declareWorkerHostEntry() 必须在模块顶层同步调用；
 * - omp 的 cli.ts 会自己派发 worker 选择子（顶层 isProcessEntry 判断）：编译版与任何 worker 线程里，
 *   import cli 这一下就已经派发了，我们再 runCli 一次 = 同一个 worker 起两份（两个 JsRuntime 同吃一条
 *   run 消息、两个 broker 抢同一根命名管道）。所以只在 cli 不会自派发时（开发版的主线程子进程）由我们派发；
 * - worker 线程里父线程立刻发的 init 握手只在入口模块顶层求值结束时冲刷一次，cli 自派发的
 *   installWorkerInbox 已在那之后 —— 同步前缀里先挂 `holdEarlyMessages` 接住，再原样交给 omp 的收件箱。
 */
declareWorkerHostEntry()

export type ProcessMode = 'serve' | 'worker' | 'browser-relay' | typeof MAINTENANCE_MODE

/** 永不兑现：worker 与 relay 都由 omp 自己接管生命周期 */
function never(): Promise<never> {
  return new Promise<never>(() => undefined)
}

function relayArgsOrExit(args: readonly string[]): readonly string[] {
  try {
    return withRelayToken(args)
  } catch (error) {
    process.stderr.write(`browser-relay 拒绝启动：${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
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
    // omp 知识 #2：browser-relay 子命令走 runCli(argv)；编译版里 cli 已经自己派发过（omp 知识 #1）。
    // 编译版的 cli 在 import 那一下就按 process.argv 自派发，所以 `/ext` 口令必须在 import 之前写回 process.argv；
    // 开发版由我们把同一份参数交给 runCli。
    const relayArgs = relayArgsOrExit(argv.slice(2))
    process.argv.splice(2, process.argv.length - 2, ...relayArgs)
    const cli = await import('@oh-my-pi/pi-coding-agent/cli')
    if (!ompCliSelfDispatches()) void cli.runCli([...relayArgs])
    return never()
  }
  if (selector === MAINTENANCE_MODE) {
    // 维护子进程（maintenance.ts）：跑完即退，退出码交给拉起它的 Core
    process.exit(await runMaintenance(argv.slice(3)))
  }
  if (selector === 'serve') return 'serve'
  process.stderr.write(`未知模式：${selector}\n`)
  process.exit(2)
}
