import { describe, expect, test } from 'bun:test'
import { RpcPeer } from '@poietica/rpc'
import { transportPair } from '@poietica/rpc/testing'
import { createRuntimeKernel } from '@poietica/runtime-kernel'
import { arpMethods } from '@poietica/runtime-protocol'
import { createFakeEngine } from '@poietica/runtime-protocol-testkit'
import { createTestLogger, fakeClock, tempDir } from '@poietica/test-kit'
import { createArpHandlers } from '../handlers'
import { createOmpRuntimeWorker } from '../runtime'

describe('omp ARP over runtime-kernel', () => {
  test('run.submit 后的 AgentEvent 经 runtime.event 流出', async () => {
    const clock = fakeClock()
    const engine = createFakeEngine({ clock })
    engine.freezeTools()
    const [workerSide, coreSide] = transportPair()
    const worker = createOmpRuntimeWorker({
      engine,
      transport: workerSide,
      logger: createTestLogger(),
      info: { runtimeVersion: 'test', engineVersion: 'fake' },
    })
    const events: { key: string; event: { type: string } }[] = []
    const core = new RpcPeer({
      name: 'arp-event-core',
      transport: coreSide,
      logger: createTestLogger(),
      onNotification: (method, params) => {
        if (method !== 'runtime.event') return
        const value = params as { key: string; event: { type: string } }
        events.push(value)
      },
    })
    const dir = await tempDir('omp-arp-events-')
    try {
      await core.request(arpMethods.sessionOpen, {
        key: 'k',
        cwd: dir.path,
        sessionFile: null,
        posture: 'auto-edit',
        model: null,
        thinking: null,
      })
      await core.request(arpMethods.runSubmit, {
        key: 'k',
        text: '你好',
        images: [],
        files: [],
        skills: [],
        deliverAs: 'turn',
      })
      for (let i = 0; i < 10; i += 1) await clock.advanceAsync(20)
      expect(events.some((entry) => entry.key === 'k' && entry.event.type === 'timeline')).toBe(true)
      await core.request(arpMethods.sessionClose, { key: 'k' })
    } finally {
      core.dispose()
      await worker.dispose()
      await dir.dispose()
    }
  })

  test('hello 后直接调 session.*，事件通道保持空闲', async () => {
    const engine = createFakeEngine()
    engine.freezeTools()
    const [workerSide, coreSide] = transportPair()
    const arp = createArpHandlers({ engine, emit: () => undefined })
    const kernel = createRuntimeKernel({
      transport: workerSide,
      logger: createTestLogger(),
      info: { runtimeVersion: 'test', engineVersion: 'fake' },
      handlers: arp.handlers,
    })
    const core = new RpcPeer({ name: 'arp-test-core', transport: coreSide, logger: createTestLogger() })
    const dir = await tempDir('omp-arp-kernel-')
    try {
      const hello = (await core.request(arpMethods.hello, { protocolVersion: 1, coreVersion: '0.5.20' })) as {
        capabilities: string[]
      }
      expect(hello.capabilities).toEqual(expect.arrayContaining([arpMethods.sessionOpen, arpMethods.sessionPage]))
      await core.request(arpMethods.sessionOpen, {
        key: 'k',
        cwd: dir.path,
        sessionFile: null,
        posture: 'auto-edit',
        model: null,
        thinking: null,
      })
      const page = (await core.request(arpMethods.sessionPage, { key: 'k', agentId: 'main', beforeTurnId: null })) as {
        items: unknown[]
      }
      expect(page.items).toEqual([])
      await core.request(arpMethods.sessionClose, { key: 'k' })
    } finally {
      core.dispose()
      kernel.peer.dispose()
      await arp.dispose()
      await dir.dispose()
    }
  })
})
