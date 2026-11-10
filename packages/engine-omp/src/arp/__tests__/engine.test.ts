import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { ArpEngine } from '@poietica/runtime-manager'
import { createTestLogger, tempDir } from '@poietica/test-kit'

const worker = path.join(import.meta.dir, 'fixtures', 'engine-worker.ts')

describe('ArpEngine', () => {
  test('会话与 ports 都经 ARP 到 Worker', async () => {
    const engine = await ArpEngine.connect({
      launch: { command: process.execPath, args: [worker] },
      logger: createTestLogger(),
      readyTimeoutMs: 5_000,
    })
    const dir = await tempDir('arp-engine-')
    try {
      expect(engine.info).toEqual({ name: 'omp', version: 'fake' })
      expect(engine.browserRelay()).toBeNull()
      expect(engine.settings.groupOrder).toBeArray()
      expect(await engine.models.providers()).toBeArray()
      const session = await engine.openSession({
        key: 'k',
        cwd: dir.path,
        sessionFile: null,
        posture: 'auto-edit',
        model: null,
        thinking: null,
      })
      expect(session.state()).toBe('idle')
      expect((await session.page('main', null)).items).toEqual([])
      await session.dispose()
    } finally {
      await engine.dispose()
      await dir.dispose()
    }
  })
})
