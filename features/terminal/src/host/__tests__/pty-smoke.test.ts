import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { which } from '@poietica/process-kit'

/*
 * TM-9：真实 PTY 冒烟 —— 打开终端 → 写入 `echo hi\r` → 2 秒内输出包含 `hi`（07 页 §11G）。
 *
 * 为什么不是在 bun test 进程里直接开 PTY：node-pty 的**生产宿主是 Electron 主进程**
 * （Node 运行时），而 Bun 1.4.2 在 Windows 上给不了 ConPTY 输出 —— 实测同一个探针，
 * Bun 下只收到 ConPTY 的 16 字节初始化序列（ESC[?9001h ESC[?1004h）后 shell 永不产出，
 * Node 下立刻收到输出。在 Bun 里断言「没输出」是假红：它测的是 Bun 的 spawn，
 * 不是产品要跑的那条路。
 *
 * 这一条因此开一个 Node 子进程，让它加载本功能的 @lydell/node-pty 走真实 ConPTY ——
 * 与 Electron 主进程同一个运行时、同一份原生模块。Node 不在 PATH 上时跳过。
 */

const PROBE = [
  "const { spawn } = require('@lydell/node-pty')",
  'const pty = spawn(process.env.SMOKE_SHELL, ["-NoLogo", "-NoProfile"], {',
  "  name: 'xterm-256color',",
  '  cwd: process.env.SMOKE_CWD,',
  '  cols: 120,',
  '  rows: 30,',
  '})',
  "let out = ''",
  'pty.onData((d) => { out += d })',
  "setTimeout(() => pty.write('echo hi\\r'), 800)",
  'const deadline = Date.now() + 2000',
  'const poll = setInterval(() => {',
  "  if (out.includes('hi')) { clearInterval(poll); console.log('SMOKE-OK'); pty.kill(); process.exit(0) }",
  '  if (Date.now() > deadline) { clearInterval(poll);',
  "    console.log('SMOKE-TIMEOUT ' + JSON.stringify(out.slice(-120))); pty.kill(); process.exit(1) }",
  '}, 50)',
].join('\n')

/** 本包 node_modules：@lydell/node-pty 的链接在这里，Node 用 NODE_PATH 才解析得到。 */
const nodeModules = fileURLToPath(new URL('../../../node_modules', import.meta.url))

describe('TM-9: 真实 PTY 冒烟（Electron/Node 运行时）', () => {
  test.skipIf(process.platform !== 'win32')(
    '打开 shell → echo hi → 2 秒内输出包含 hi',
    async () => {
      const node = await which('node')
      const shell = (await which('pwsh.exe')) ?? (await which('powershell.exe'))

      /* 没有 Node 或没有 PowerShell：没有与生产一致的运行时，跳过而不是假绿。 */
      if (node === null || shell === null) {
        return
      }

      const out = execFileSync(node, ['-e', PROBE, shell, process.cwd()], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_PATH: nodeModules, SMOKE_SHELL: shell, SMOKE_CWD: process.cwd() },
        encoding: 'utf8',
        timeout: 20_000,
      })

      expect(out).toContain('SMOKE-OK')
    },
    30_000,
  )
})
