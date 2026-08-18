import type { RunEvent } from '@poietica/agent-contract'

/**
 * 一轮手写的会话：思考、工具、回答、干净收尾。界面在任何 agent 进程存在之前就
 * 靠它开发。
 *
 * 它是插图，永远不是证据：要被相信的帧只能来自真实 agent。
 */
export const SAMPLE_RUN_EVENTS: readonly RunEvent[] = [
  /* seq 从 1 起编：写 0 会被 apply 的去重当成重复帧整帧丢掉。 */
  {
    kind: 'run_started',
    seq: 1,
    at: 1_000,
    sessionId: 'sess_demo',
    prompt: '把 README 里的构建命令核对一遍',
  },
  {
    kind: 'kap_event',
    seq: 2,
    at: 1_010,
    payload: { type: 'thinking.delta', delta: '先读取 README，' },
  },
  {
    kind: 'kap_event',
    seq: 3,
    at: 1_020,
    payload: { type: 'thinking.delta', delta: '再与 package.json 对照。' },
  },
  {
    kind: 'kap_event',
    seq: 4,
    at: 1_050,
    payload: {
      type: 'tool.call.started',
      toolCallId: 'call_1',
      name: 'Read README.md',
      args: { path: 'README.md' },
      display: { kind: 'file_io', operation: 'read', path: 'README.md' },
    },
  },
  {
    kind: 'kap_event',
    seq: 5,
    at: 1_090,
    payload: { type: 'tool.result', toolCallId: 'call_1', output: '# Poietica ...' },
  },
  {
    kind: 'kap_event',
    seq: 6,
    at: 1_100,
    payload: { type: 'assistant.delta', delta: '构建命令与 scripts 一致。' },
  },
  { kind: 'run_finished', seq: 7, at: 1_110, stopReason: 'completed' },
]
