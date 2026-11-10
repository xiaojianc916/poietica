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
    const arp = createArpHandlers({ engine, emit: (p) => events.push(p) })
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
})
