import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createCoreKernel } from '@poietica/core-kernel'
import { appContract } from '@poietica/protocol'
import { RpcPeer } from '@poietica/rpc'
import { transportPair } from '@poietica/rpc/testing'
import { dataLayout } from '@poietica/runtime-layout'
import { createFakeEngine } from '@poietica/runtime-protocol-testkit'
import { createTestLogger, fakeClock, tempDir } from '@poietica/test-kit'
import { coreModules, featureDescriptors, retiredCoreModules } from '../modules'

/**
 * 装配的启动前提（P6 描述符）：每个功能都有自己的描述符，依赖方向按级别严格递减。
 *
 * 这条闸门是补出来的：内核在 `start()` 里才校验它，而 `createCoreHarness` 只装被测模块、
 * 不带描述符 —— 于是「两个功能同为第 N 级却互相依赖」能在全绿的单测里活到真机启动
 * （policy 依赖 journal、两者都在第 1 级就是这样漏过去的：Core 起不来，界面只报「引擎启动失败」）。
 * 这里用**真实的装配清单**把那条检查提前到测试里，并真的把内核拉起来一次。
 */
describe('Core 装配清单（真实模块 + 真实描述符）', () => {
  test('每个模块都有描述符，级别与依赖方向自洽', () => {
    /* featureDescriptors 是 as const 的：按 string 查找要先摊平成普通 Map */
    const byId = new Map<string, { readonly tier: number }>(
      Object.values(featureDescriptors).map((descriptor) => [descriptor.id, descriptor]),
    )
    expect(byId.size).toBe(coreModules.length)
    for (const module of coreModules) {
      const descriptor = byId.get(module.id)
      expect({ id: module.id, described: descriptor !== undefined }).toEqual({ id: module.id, described: true })
      for (const dependency of module.dependsOn ?? []) {
        const upstream = byId.get(dependency)
        /* 只有功能之间的依赖受这条规则管；内核服务（settings 等）也是功能，一并覆盖 */
        if (upstream === undefined) continue
        expect({
          module: module.id,
          dependency,
          ok: upstream.tier < (descriptor?.tier ?? 0),
        }).toEqual({ module: module.id, dependency, ok: true })
      }
    }
  })

  test('真实装配能启动到 core.ready（依赖顺序与描述符一致）', async () => {
    const dir = await tempDir('core-assembly-')
    const [coreSide, hostSide] = transportPair()
    const log = createTestLogger()
    const host = new RpcPeer({
      name: 'test-host',
      transport: hostSide,
      logger: createTestLogger(),
      onRequest: async (method) => {
        if (method === 'secrets.lease') return { entries: {} }
        throw new Error(`测试未提供 Host 方法 ${method} 的应答`)
      },
    })
    const kernel = createCoreKernel({
      modules: coreModules,
      moduleDescriptors: Object.values(featureDescriptors),
      retiredModules: retiredCoreModules,
      engine: createFakeEngine({ clock: fakeClock() }),
      databaseFile: join(dir.path, 'core.db'),
      layout: dataLayout(dir.path),
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
    expect(log.at('error')).toEqual([])
    await kernel.shutdown('test')
    host.dispose()
    await dir.dispose()
  }, 30_000)
})
