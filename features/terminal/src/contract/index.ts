import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { TerminalId, TerminalInfo } from './entities'
import { terminalErrors } from './errors'

export * from './entities'
export { terminalErrors } from './errors'

const empty = z.object({})
const terminalRef = z.object({ terminalId: TerminalId })

export const terminalContract = defineContract({
  id: 'terminal',
  namespaces: ['terminal'],
  methods: [
    defineMethod({
      name: 'terminal.open',
      owner: 'host',
      params: z.object({ cwd: z.string().nullable(), cols: z.number().int(), rows: z.number().int() }),
      result: TerminalInfo,
      description: '打开一个终端；cwd 为 null 时用用户主目录',
    }),
    defineMethod({
      name: 'terminal.write',
      owner: 'host',
      params: z.object({ terminalId: TerminalId, data: z.string() }),
      result: empty,
      description: '把按键字节写给 PTY',
    }),
    defineMethod({
      name: 'terminal.resize',
      owner: 'host',
      params: z.object({ terminalId: TerminalId, cols: z.number().int(), rows: z.number().int() }),
      result: empty,
      description: '调整 PTY 网格',
    }),
    defineMethod({
      name: 'terminal.close',
      owner: 'host',
      params: terminalRef,
      result: empty,
      description: '关闭终端并杀掉整棵进程树',
    }),
    defineMethod({
      name: 'terminal.list',
      owner: 'host',
      params: empty,
      result: z.object({ terminals: z.array(TerminalInfo) }),
      description: '当前全部终端（渲染进程重载后恢复画面用）',
    }),
    defineMethod({
      name: 'terminal.replay',
      owner: 'host',
      params: terminalRef,
      result: z.object({ data: z.string() }),
      description: '最近 256 KB 输出（重放）',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'terminal.output',
      owner: 'host',
      params: z.object({ terminalId: TerminalId, data: z.string() }),
      description: 'PTY 输出（8ms 合批）',
    }),
    defineNotification({
      name: 'terminal.exited',
      owner: 'host',
      params: z.object({ terminalId: TerminalId, exitCode: z.number().int().nullable() }),
      description: 'PTY 退出；输出已先排空',
    }),
  ],
  errors: terminalErrors,
})
