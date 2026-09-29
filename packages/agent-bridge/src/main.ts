/*
 * stdio 适配器：把 bridge 的进程内调用面接回「一行一条 JSON」的线上。
 *
 * 线上形状的正本是 protocol.ts（与 crates/agent-client/src/wire.rs 逐字对应）。
 * 这一层只做编解码与配对，命令怎么执行归 bridge.ts —— 两处都写就是两个判别点。
 *
 * 唯一调用方是 Rust 的 agent-client：它 spawn 这个进程，用 stdin/stdout 说话。
 */

import { type BridgeHost, createBridge } from './bridge.ts'
import { BRIDGE_PROTOCOL_VERSION, type BridgeCommand, type BridgeFrame } from './protocol.ts'

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
    void respond(command)
  }
}

async function respond(command: BridgeCommand): Promise<void> {
  try {
    const data = await bridge.dispatch(command)
    write({ type: 'response', id: command.id, data })
  } catch (error) {
    write({
      type: 'failed',
      id: command.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
