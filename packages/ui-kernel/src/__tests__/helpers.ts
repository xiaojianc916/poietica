import { defineContract, defineErrors, defineMethod, defineNotification } from '@poietica/contract-kit'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { z } from 'zod'

export const alphaContract = defineContract({
  id: 'alpha',
  namespaces: ['alpha'],
  methods: [
    defineMethod({
      name: 'alpha.echo',
      owner: 'core',
      params: z.object({ v: z.string() }),
      result: z.object({ v: z.string() }),
      description: 'echo',
    }),
    defineMethod({
      name: 'alpha.bad',
      owner: 'core',
      params: z.object({}),
      result: z.object({ ok: z.boolean() }),
      description: '返回不符合契约的值',
    }),
  ],
  notifications: [
    defineNotification({ name: 'alpha.tick', owner: 'core', params: z.object({ n: z.number() }), description: 'tick' }),
  ],
  errors: defineErrors('alpha', { boom: '炸了' }),
})

export const betaContract = defineContract({
  id: 'beta',
  namespaces: ['beta'],
  methods: [],
  notifications: [],
  errors: defineErrors('beta', {}),
})

export interface TestBridge extends WindowBridge {
  /** 测试里模拟 Host → UI 的通知 */
  emit(message: RpcMessage): void
  readonly sent: RpcMessage[]
  /** 断开：模拟 Host 重启渲染进程的端口 */
  drop(): void
  readonly isDropped: () => boolean
}

/**
 * 一个不依赖真实 Host 的 bridge：send 把消息记下来，测试用 respond 回复。
 * onRequest 收到请求时调用 handler 决定应答。
 */
export function createTestBridge(
  handler: (method: string, params: unknown) => Promise<unknown> | unknown,
  opts: { coreStatus?: unknown } = {},
): TestBridge {
  const messageListeners = new Set<(m: RpcMessage) => void>()
  const sent: RpcMessage[] = []
  let dropped = false
  const bridge: TestBridge = {
    sent,
    isDropped: () => dropped,
    emit(message) {
      for (const l of [...messageListeners]) l(message)
    },
    drop() {
      dropped = true
    },
    send(message) {
      if (dropped) return
      sent.push(message)
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
        const { id, method, params } = message
        const reply = (async (): Promise<void> => {
          try {
            const result = await handler(method, params)
            queueMicrotask(() => bridge.emit({ jsonrpc: '2.0', id, result: result ?? null }))
          } catch (e) {
            queueMicrotask(() =>
              bridge.emit({
                jsonrpc: '2.0',
                id,
                error: {
                  code: -32000,
                  message: e instanceof Error ? e.message : String(e),
                  data: { code: (e as { code?: string }).code ?? 'kernel.internal', message: String(e) },
                },
              }),
            )
          }
        })()
        void reply
      } else if (opts.coreStatus === undefined) {
        // 通知：测试自己决定何时 emit
      }
    },
    onMessage(listener) {
      messageListeners.add(listener)
      return () => {
        messageListeners.delete(listener)
      }
    },
    pathForFile: () => 'C:\\\\tmp\\\\file.txt',
  }
  return bridge
}
