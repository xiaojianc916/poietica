// 子进程：模拟 Core。真正的 stdout 只经 writeFrame 写帧；console.log 模拟 omp/原生模块的杂散输出。
import { noopLogger } from '@poietica/foundation'
import { RpcPeer } from '../../index'
import { createStdioTransport } from '../../stdio'

const realWrite = process.stdout.write.bind(process.stdout)
const writeFrame = (frame: string): void => {
  realWrite(frame)
}

const transport = createStdioTransport({ input: process.stdin, writeFrame, onStray: () => undefined })
const peer = new RpcPeer({
  name: 'fixture',
  transport,
  logger: noopLogger,
  onRequest: async (method, params, ctx) => {
    if (method === 'echo') return params
    if (method === 'noise') {
      console.log('杂散输出：没有帧前缀的一行')
      process.stdout.write('半行杂散')
      return { ok: true }
    }
    if (method === 'slow') {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 10_000)
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('aborted'))
        })
      })
      return {}
    }
    if (method === 'askHost') return peer.request('host.ping', { n: 1 })
    if (method === 'exit') setTimeout(() => process.exit(7), 10)
    return {}
  },
})
transport.onClose(() => process.exit(0))
