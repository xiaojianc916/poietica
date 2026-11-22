import { describe, expect, test } from 'bun:test'
import { arpMethods } from '@poietica/runtime-protocol'
import { createFakeEngine } from '@poietica/runtime-protocol-testkit'
import { tempDir } from '@poietica/test-kit'
import { createArpHandlers } from '../handlers'

describe('omp ARP handlers', () => {
  test('session.open / page / close 走真实 AgentEngine 端口', async () => {
    const engine = createFakeEngine()
    engine.freezeTools()
    const events: unknown[] = []
    const arp = createArpHandlers({ engine, callCore: async () => ({}), emit: (p) => events.push(p) })
    const dir = await tempDir('omp-arp-')
    try {
      const opened = (await arp.handlers[arpMethods.sessionOpen]!({
        key: 'thread-1',
        cwd: dir.path,
        sessionFile: null,
        posture: 'auto-edit',
        model: null,
        thinking: null,
      })) as { sessionId: string; sessionFile: string }
      expect(opened.sessionId).toBeString()
      expect(opened.sessionFile).toBeString()

      const page = (await arp.handlers[arpMethods.sessionPage]!({
        key: 'thread-1',
        agentId: 'main',
        beforeTurnId: null,
      })) as { items: unknown[] }
      expect(page.items).toEqual([])

      await arp.handlers[arpMethods.sessionClose]!({ key: 'thread-1' })
      expect(events).toEqual([])
    } finally {
      await arp.dispose()
      await dir.dispose()
    }
  })

  test('engineCall 保留 null：Python 解释器没设置时不能折成空对象', async () => {
    const engine = createFakeEngine()
    const arp = createArpHandlers({ engine, callCore: async () => ({}), emit: () => undefined })
    try {
      const call = async (path: readonly string[], args: readonly unknown[]): Promise<unknown> =>
        await arp.handlers[arpMethods.engineCall]!({ path, args })

      expect(await call(['settings', 'getPythonInterpreter'], [])).toBeNull()

      await engine.settings.setPythonInterpreter('C:\\Python315\\python.exe')
      expect(await call(['settings', 'getPythonInterpreter'], [])).toBe('C:\\Python315\\python.exe')

      /* void 方法仍然折成 {}：桥上不能回 undefined。 */
      expect(await call(['settings', 'setPythonInterpreter'], ['C:\\Python315\\python.exe'])).toEqual({})
    } finally {
      await arp.dispose()
    }
  })
})
