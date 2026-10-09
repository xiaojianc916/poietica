import { spawn } from '@lydell/node-pty'
import { defineHostModule } from '@poietica/host-kernel'
import { killTree } from '@poietica/process-kit'
import { terminalContract } from '../contract'
import { createTerminalService } from './terminal-service'

export default defineHostModule({
  id: 'terminal',
  contract: terminalContract,
  setup(ctx) {
    /*
     * 只有这一个文件 import @lydell/node-pty（07 页 §11D）：native 模块加载失败
     * 只影响 terminal，其它功能照常。service 本身经 PtyFactory 注入，可被假 PTY 测。
     */
    const service = createTerminalService({
      logger: ctx.logger,
      /*
       * @lydell/node-pty 在 Windows 上**只有** ConPTY 一条路（没有 winpty 分支），
       * 所以方案里的 useConpty: true 在这个依赖上没有对应选项；不写即为它的唯一行为。
       */
      spawn: (shell, o) =>
        spawn(shell.file, [...shell.args], {
          name: 'xterm-256color',
          cwd: o.cwd,
          cols: o.cols,
          rows: o.rows,
          env: o.env,
        }),
      emitOutput: (terminalId, data, offset) => ctx.rpc.emit('terminal.output', { terminalId, data, offset }),
      emitExited: (terminalId, exitCode) => ctx.rpc.emit('terminal.exited', { terminalId, exitCode }),
      killTree,
    })
    ctx.rpc.handle('terminal.open', (p) => service.open(p))
    ctx.rpc.handle('terminal.write', (p) => {
      service.write(p.terminalId, p.data)
      return {}
    })
    ctx.rpc.handle('terminal.resize', (p) => {
      service.resize(p.terminalId, p.cols, p.rows)
      return {}
    })
    ctx.rpc.handle('terminal.close', async (p) => {
      await service.close(p.terminalId)
      return {}
    })
    ctx.rpc.handle('terminal.list', () => ({ terminals: service.list() }))
    ctx.rpc.handle('terminal.replay', (p) => service.replay(p.terminalId))
    ctx.lifecycle.onShutdown(() => service.disposeAll())
  },
})
