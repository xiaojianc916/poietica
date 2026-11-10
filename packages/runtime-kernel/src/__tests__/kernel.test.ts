import { describe, expect, test } from 'bun:test'
import type { AppError } from '@poietica/foundation'
import { RpcPeer } from '@poietica/rpc'
import { transportPair } from '@poietica/rpc/testing'
import { ARP_VERSION, arpErrors, arpMethods } from '@poietica/runtime-protocol'
import { createTestLogger } from '@poietica/test-kit'
import { createRuntimeKernel } from '../index'

function pair(handlers?: Record<string, (p: unknown) => unknown>, onShutdown?: (reason: string) => void) {
  const [workerSide, coreSide] = transportPair()
  const kernel = createRuntimeKernel({
    transport: workerSide,
    logger: createTestLogger(),
    info: { runtimeVersion: '0.1.0', engineVersion: '18.16.0' },
    handlers,
    capabilities: ['session', 'run'],
    onShutdown,
  })
  const core = new RpcPeer({
    name: 'test-core',
    transport: coreSide,
    logger: createTestLogger(),
  })
  return { kernel, core }
}

describe('runtime-kernel', () => {
  test('hello 交回版本与能力；版本不一致拒绝', async () => {
    const { kernel, core } = pair()
    const hello = (await core.request(arpMethods.hello, { protocolVersion: ARP_VERSION, coreVersion: '0.5.20' })) as {
      protocolVersion: number
      runtimeVersion: string
      engineVersion: string
      capabilities: string[]
    }
    expect(hello).toMatchObject({ protocolVersion: ARP_VERSION, runtimeVersion: '0.1.0', engineVersion: '18.16.0' })
    expect(hello.capabilities).toEqual(expect.arrayContaining(['runtime.hello', 'session', 'run']))

    const mismatch = await core
      .request(arpMethods.hello, { protocolVersion: ARP_VERSION + 1, coreVersion: '0.5.20' })
      .catch((e: unknown) => e)
    expect((mismatch as AppError).code).toBe(arpErrors.protocolMismatch)
    kernel.peer.dispose()
    core.dispose()
  })

  test('注入的方法按名字处理；未知方法报 method_not_found；shutdown 走 onShutdown', async () => {
    const shutdowns: string[] = []
    const { kernel, core } = pair({ 'session.count': (p) => ({ count: (p as { n: number }).n }) }, (reason) =>
      shutdowns.push(reason),
    )
    expect(await core.request('session.count', { n: 2 })).toEqual({ count: 2 })
    const missing = await core.request('session.missing', {}).catch((e: unknown) => e)
    expect((missing as AppError).code).toBe('kernel.method_not_found')

    expect(await core.request(arpMethods.shutdown, {})).toEqual({})
    await new Promise((resolve) => setTimeout(resolve, 5))
    await kernel.shutdown('test')
    expect(shutdowns).toEqual(['requested'])
    core.dispose()
  })
})
