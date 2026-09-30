/*
 * 这一次 `bun test` 用的受控 agent home，以及 SDK 的那几个入口。
 *
 * SDK 的 agent 目录是**模块加载时解析、进程内唯一**的（pi-utils 的 dirs.ts），而 bun 把
 * 一个目录下的测试文件放在同一个进程里跑。哪个文件自己另造一个临时目录，后加载的那个
 * 就会让先加载的那个在 createBridge 对账时炸「agent home mismatch」—— 那是测试互相踩，
 * 不是桥的问题。
 *
 * 所以归属只在这里定一次：谁 import 它都是同一个值，也都按同一个值起桥。环境变量必须
 * 在 SDK import **之前**落地（晚了它就解析到用户自己的 ~/.omp，那是绝不能被写的目录），
 * 这也是这一格存在的理由 —— 把顺序关在这一个模块里，别让每个测试文件各写一遍。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

if (process.env['PI_CODING_AGENT_DIR'] === undefined) {
  process.env['PI_CODING_AGENT_DIR'] = mkdtempSync(path.join(tmpdir(), 'poietica-agent-home-'))
}

const sdk = await import('@oh-my-pi/pi-coding-agent')

/** SDK 实际解析到的那个 home：起桥时必须原样交给它，否则就是对账失败。 */
export const home = sdk.getAgentDir()
export const { AgentSession } = sdk
export { createBridge } from '../bridge.ts'
