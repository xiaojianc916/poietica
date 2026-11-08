import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createCoreKernel } from '@poietica/core-kernel'
import { createFakeEngine } from '@poietica/engine-testkit'
import { appContract } from '@poietica/protocol'
import { RpcPeer } from '@poietica/rpc'
import { transportPair } from '@poietica/rpc/testing'
import { dataLayout } from '@poietica/runtime-layout'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger, fakeClock, tempDir } from '@poietica/test-kit'
import { coreModules, retiredCoreModules } from '../modules'

/*
 * ADR-004 的端到端兜底：库比程序新时 Core 以只读模式打开。只读模式「能启动、能看」的前提是
 * 所有真实模块的 setup / onReady 都不往库里写 —— 哪个模块在启动路径上写了库，这里就会看到 error 日志或启动失败。
 */
async function boot(dataDir: string) {
  const [coreSide, hostSide] = transportPair()
  const log = createTestLogger()
  const notices: unknown[] = []
  const host = new RpcPeer({
    name: 'test-host',
    transport: hostSide,
    logger: createTestLogger(),
    onNotification: (method, params) => {
      if (method === 'core.notice') notices.push(params)
    },
    onRequest: async (method) => {
      if (method === 'secrets.lease') return { entries: {} }
      throw new Error(`测试未提供 Host 方法 ${method} 的应答`)
    },
  })
  const kernel = createCoreKernel({
    modules: coreModules,
    retiredModules: retiredCoreModules,
    engine: createFakeEngine(),
    databaseFile: join(dataDir, 'core.db'),
    layout: dataLayout(dataDir),
    logger: log,
    clock: fakeClock(),
    transport: coreSide,
    appContract,
    protocolVersion: 0,
    coreVersion: 'test',
    engineVersion: 'test',
    strict: true,
    runtime: { scrubbedEnvKeys: [], setLogLevel: () => undefined },
  })
  await kernel.start()
  await new Promise((r) => setTimeout(r, 20))
  return {
    kernel,
    log,
    notices,
    async dispose() {
      await kernel.shutdown('test')
      host.dispose()
    },
  }
}

describe('真实模块在只读库上启动（ADR-004）', () => {
  test('库比程序新：全部模块照常启动，启动路径上没有写库', async () => {
    const dir = await tempDir('core-readonly-')
    const first = await boot(dir.path)
    expect(first.log.at('error')).toEqual([])
    await first.dispose()

    /* 模拟「新版本跑过一次又降级回来」：把每个模块记录的版本都抬高一格 */
    const db = openDatabase(join(dir.path, 'core.db'))
    db.raw.exec('UPDATE kernel_migrations SET version = version + 1')
    db.close()

    const second = await boot(dir.path)
    expect(second.notices).toContainEqual(
      expect.objectContaining({ level: 'warn', data: { dataMode: 'readOnly', reason: 'data_too_new' } }),
    )
    expect(second.log.at('error')).toEqual([])
    await second.dispose()
    await dir.dispose()
  }, 30_000)
})
