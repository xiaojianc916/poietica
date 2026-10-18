/**
 * Core 的维护子进程：`<core> gc --agent-dir <omp agent 目录>`，跑 omp 自己的会话媒体回收（`omp gc` 的 blobs 段）。
 * 由 Core 在启动对账之后拉起（ports/omp-gc.ts），跑完即退；结果是 omp 的 JSON，写在本进程的 stdout 上。
 *
 * 为什么另起子进程而不是在 Core 里直接调：omp 的 runGcCommand 把结果写进 process.stdout，而 Core 的 stdout 是
 * RPC 帧通道（stdout-guard）；标记阶段要把全部会话文件读一遍，放在子进程里也不和 Core 的事件循环、内存抢。
 *
 * 只跑 blobs 一段，其余三段在 Poietica 里都不对：
 * - archive 把冷会话**移走**（压进 archive/）：线程行绑着会话文件的路径，移走就成了「会话文件不在」；
 * - wal 对 omp 的 sqlite 做 TRUNCATE checkpoint：Core 正开着这些库，忙时报错；
 * - stale 清的是 omp 终端版的面包屑与报告目录：Poietica 不产生。
 *
 * 本文件不静态 import 任何 omp 模块（process-mode.ts 的规矩）：gc-cli 在分支里动态加载；
 * 也不 import omp 的 `cli` —— 编译版里它一被 import 就按 argv 自己派发（omp 知识 #1），会把 `gc` 当成 omp 自己的子命令再跑一遍。
 */
export const MAINTENANCE_MODE = 'gc'

const AGENT_DIR_FLAG = '--agent-dir'

/** 跑一次回收，返回退出码：0 = 跑完（个别文件删不掉记在 JSON 的 errors 里），1 = 没跑成，2 = 参数不对 */
export async function runMaintenance(args: readonly string[]): Promise<number> {
  const at = args.indexOf(AGENT_DIR_FLAG)
  const agentDir = at < 0 ? undefined : args[at + 1]
  if (agentDir === undefined || agentDir === '') {
    process.stderr.write(`gc 缺少 ${AGENT_DIR_FLAG}\n`)
    return 2
  }
  try {
    const { runGcCommand } = await import('@oh-my-pi/pi-coding-agent/cli/gc-cli')
    await runGcCommand({ flags: { apply: true, json: true, agentDir, blobs: true } })
    return 0
  } catch (error) {
    process.stderr.write(`gc 失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
