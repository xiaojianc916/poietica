/*
 * stdio 适配器：把 bridge 的进程内调用面接回「一行一条 JSON」的线上。
 *
 * 线上形状的正本是 protocol.ts（与 crates/agent-client/src/wire.rs 逐字对应）。
 * 这一层只做编解码与配对，命令怎么执行归 bridge.ts —— 两处都写就是两个判别点。
 *
 * 唯一调用方是 Rust 的 agent-client：它 spawn 这个进程，用 stdin/stdout 说话。
 */

import { parentPort } from 'node:worker_threads'

import {
  declareWorkerHostEntry,
  installWorkerInbox,
  isWorkerHostSelector,
} from '@oh-my-pi/pi-utils/worker-host'

import { type BridgeHost, createBridge } from './bridge.ts'
import { BRIDGE_PROTOCOL_VERSION, type BridgeCommand, type BridgeFrame } from './protocol.ts'
import { runCliCommand, runWorkerSelector } from './workers.ts'

/*
 * 这个进程同时是 SDK 的 **worker host**，而不只是 stdio 服务。
 *
 * SDK 起 worker 分两路（eval/js/context-manager.ts:1010、tools/browser/tab-supervisor.ts:1613、
 * tools/computer/supervisor.ts:115、launch/terminal-output-worker-client.ts:16 四处同形）：
 * 先问 workerHostEntry()，拿到就 new Worker(它, { argv: [选择器] })；拿不到就退回
 * `new URL("./worker-entry.ts", import.meta.url)` —— 那个相对路径在打包产物里不存在，
 * 于是 eval、浏览器标签监管、computer use、终端输出四样一起废。
 *
 * workerHostEntry() 只由 declareWorkerHostEntry() 设置，而 SDK 只在 src/cli.ts 里调它一次，
 * 条件是 import.meta.main 或 PI_COMPILED。我们两个入口都不是 cli.ts，PI_COMPILED 又被
 * 档案刻意摘掉（packages/agent-catalog/src/omp/descriptor.ts 的 unsetEnv），所以这里必须
 * 自己声明 —— 声明的是**本文件**（Bun.main 指向它），worker 于是重新执行本文件并带上选择器。
 *
 * 这一句必须在任何 await 之前：Bun 在入口模块顶层求值结束的那一刻，把 spawn 前的消息
 * 一次性冲给当时在场的 message 监听器，晚一步就丢（pi-utils 的 worker-host.ts 注释）。
 */
declareWorkerHostEntry()

if (isWorkerHostSelector(process.argv[2])) {
  /*
   * 收件箱必须在**第一个 await 之前**挂上。
   *
   * Bun 在入口模块顶层求值结束的那一刻，把 spawn 前父进程 post 的消息一次性冲给当时
   * 在场的 message 监听器。runWorkerSelector 里那句动态 import 是一个 await —— 它一挂起，
   * 顶层求值就算结束，父进程同步 post 的 init 握手当场丢掉，之后 worker 一直等到 init
   * 超时、静默回落到同域内联实现（SDK 注释里记的就是这个症状：eval 每次都等满超时）。
   * 所以这里同步挂，worker 模块稍后自己 consume。
   */
  if (parentPort !== null) {
    installWorkerInbox(parentPort)
  }

  await runWorkerSelector(process.argv[2])
} else if (process.argv[2] === 'browser-relay') {
  /*
   * omp 的 relay 服务端：它按 resolveWorkerSpawnCmd("browser-relay") 拉起来的就是这一支
   * （形状 `[运行时, 本文件, "browser-relay", "--port", N]`，见 workers.ts）。
   *
   * 参数原样递给 CLI：端口、--token 这些是它自己的命令行面，我们再抄一份就是第二个事实。
   */
  await runCliCommand(process.argv.slice(2))
} else {
  await serve()
}

/** 常规路径：一行一条 JSON 的 stdio 服务。 */
async function serve(): Promise<void> {
  const write = (frame: BridgeFrame): void => {
    process.stdout.write(`${JSON.stringify(frame)}\n`)
  }

  /*
   * 宿主上下文来自 Rust 已经设好的环境：受控 home 是 PI_CODING_AGENT_DIR（档案里的 homeVar，
   * 由 agent-client 按档案设进 spawn 的环境），工作区是 spawn 时的 cwd —— 那个进程就是为
   * 这条工作区起的（agent-client 的 session/bridge.rs 把它交给 Command::current_dir）。
   *
   * 缺了受控 home 就报错退出：SDK 会回落到用户自己的 ~/.omp，那是写到别人的盘上。
   */
  function hostFromEnvironment(): BridgeHost {
    const agentDir = process.env['PI_CODING_AGENT_DIR']

    if (agentDir === undefined || agentDir === '') {
      throw new Error('PI_CODING_AGENT_DIR is not set: refusing to write to the user’s own ~/.omp')
    }

    return { agentDir, cwd: process.cwd() }
  }

  /* 桥报上来的事件原样转发：线上那一层不认识事件内部形状。 */
  const bridge = createBridge(hostFromEnvironment())

  bridge.subscribe((event) => {
    write({ type: 'event', event })
  })

  write({
    type: 'ready',
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    agentVersion: bridge.agentVersion,
  })

  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })

    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')

      if (line === '') {
        continue
      }

      let command: BridgeCommand
      try {
        command = JSON.parse(line) as BridgeCommand
      } catch (error) {
        write({ type: 'failed', id: '', message: `malformed command: ${String(error)}` })
        continue
      }

      // 不能 await：一轮 prompt 会挂在授权对话框上，而答复正是下一条命令，顺序处理会死锁。
      void respond(bridge, command)
    }
  }

  async function respond(
    current: ReturnType<typeof createBridge>,
    command: BridgeCommand,
  ): Promise<void> {
    try {
      const data = await current.dispatch(command)
      write({ type: 'response', id: command.id, data })
    } catch (error) {
      write({
        type: 'failed',
        id: command.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
