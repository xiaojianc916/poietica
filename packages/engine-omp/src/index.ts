// 包根只导出生产入口：createOmpEngineWith 与测试缝不给外面。
// 测试与探针要 mock 模型时走 './testing' 子入口。
import type { AgentEngine } from '@poietica/engine'
import type { Logger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import { prepareRelayToken } from './bootstrap/relay-token'
import { createOmpEngineWith } from './create-engine'
import { OMP_VERSION } from './omp-version'
import { pickFreePort } from './relay-port'

export interface CreateOmpEngineOptions {
  readonly layout: DataLayout
  readonly logger: Logger
  /** 产品版本（Core 的版本），写进 omp 的运行时上下文 */
  readonly appVersion: string
  /**
   * omp 引擎自己的版本。不传就用本包的 OMP_VERSION（生产由 apps/core/scripts/build.ts 编译期注入，
   * 源码运行与单测时从随包安装的那份 omp 现读）—— 两种来源都不写死版本号，catalog 是唯一产地。
   * engine.info.version 会进入 core.ready 载荷与 diagnostics.core，而契约要求它是 string ——
   * 缺了它，strict 模式下 diagnostics.core 整个方法失败（真实故障）。
   */
  readonly engineVersion?: string
}

/**
 * 生产入口。omp 的隔离、设置、注册表与全部端口都在这一步建好。
 *
 * browser relay 的端口与口令也在这里备好（引擎自己的事，不再经 Host 的启动参数）：端口每代 Core 现挑一个，
 * 经 `engine.browserRelay()` 报出去；口令按数据根持久化。调用方须已跑过 `scrubInjected()`（见 prepareRelayToken）。
 */
export async function createOmpEngine(o: CreateOmpEngineOptions): Promise<AgentEngine> {
  const relayPort = await pickFreePort()
  prepareRelayToken(o.layout)
  return await createOmpEngineWith({ ...o, relayPort, engineVersion: o.engineVersion ?? OMP_VERSION }, null)
}
