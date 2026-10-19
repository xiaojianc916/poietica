import net from 'node:net'

/**
 * 让操作系统分配一个空闲端口，然后立刻释放。端口交给本进程 omp 的 browser relay（不用 omp 默认的 9224，避免与全局 omp
 * 冲突）。由引擎自己挑、经 `AgentEngine.browserRelay()` 报出去——以前由 Host 挑好写进启动参数，启动契约因此认识 relay。
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no port'))))
    })
  })
}
