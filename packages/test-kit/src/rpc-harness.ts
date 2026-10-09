import { type NotificationHandler, type RequestHandler, RpcPeer } from '@poietica/rpc'
import { createTestLogger, type TestLogger } from './test-logger'
import { transportPair } from './transport-pair'

export interface RpcHarness {
  /** 发起请求的一端 */
  readonly client: RpcPeer
  /** 处理请求的一端 */
  readonly server: RpcPeer
  readonly logger: TestLogger
  /** 关闭两端 */
  dispose(): void
}

/** 两个经 transportPair 相连的 RpcPeer。server 的处理函数由参数提供；client 也可以接收 server 发来的请求/通知 */
export function rpcHarness(o: {
  readonly serverRequests?: RequestHandler
  readonly serverNotifications?: NotificationHandler
  readonly clientRequests?: RequestHandler
  readonly clientNotifications?: NotificationHandler
}): RpcHarness {
  const [clientSide, serverSide] = transportPair()
  const logger = createTestLogger()
  const client = new RpcPeer({
    name: 'test-client',
    transport: clientSide,
    logger: logger.child({ side: 'client' }),
    ...(o.clientRequests === undefined ? {} : { onRequest: o.clientRequests }),
    ...(o.clientNotifications === undefined ? {} : { onNotification: o.clientNotifications }),
  })
  const server = new RpcPeer({
    name: 'test-server',
    transport: serverSide,
    logger: logger.child({ side: 'server' }),
    ...(o.serverRequests === undefined ? {} : { onRequest: o.serverRequests }),
    ...(o.serverNotifications === undefined ? {} : { onNotification: o.serverNotifications }),
  })
  return {
    client,
    server,
    logger,
    dispose() {
      client.dispose()
      server.dispose()
      clientSide.close('harness disposed')
    },
  }
}
