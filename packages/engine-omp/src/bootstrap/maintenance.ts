/**
 * Core 的维护子进程：`<core> gc --agent-dir <omp agent 目录>`，跑 omp 自己的会话媒体回收
 * （`omp gc` 的 blobs 段）。由 Core 在启动对账之后拉起，跑完即退，结果写在本进程 stdout 上 ——
 * 另起子进程是因为 omp 的 runGcCommand 写 process.stdout，而 Core 的 stdout 是 RPC 帧通道。
 * 只跑 blobs 一段，其余三段在 Poietica 里都不对：archive 会把冷会话移走（线程行绑着路径）；
 * wal 对 Core 正开着的 sqlite 做 checkpoint；stale 清的是 omp 终端版的东西。
 * 不静态 import 任何 omp 模块（process-mode.ts 的规矩），也不 import omp 的 `cli` ——
 * 编译版里它一被 import 就按 argv 自派发（omp 知识 #1），会把 `gc` 当成 omp 的子命令再跑一遍。
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
