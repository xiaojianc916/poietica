// 包根只导出生产入口：createOmpEngineWith 与测试缝不给外面（12 页 §12.1）。
// 测试与探针要 mock 模型时走 './testing' 子入口。
import type { AgentEngine } from '@poietica/engine'
import type { Logger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import { createOmpEngineWith } from './create-engine'
import { OMP_VERSION } from './omp-version'

export interface CreateOmpEngineOptions {
  readonly layout: DataLayout
  readonly logger: Logger
  /** 本进程的 browser-relay 端口（只写运行时覆盖层，不落盘） */
  readonly relayPort: number
  /** 产品版本（Core 的版本），写进 omp 的运行时上下文 */
  readonly appVersion: string
  /**
   * omp 引擎自己的版本。不传就用本包的 OMP_VERSION（构建时由 apps/core/scripts/build.ts 注入，
   * 源码运行与单测时回落到与 catalog 锁定的版本）。
   * engine.info.version 会进入 core.ready 载荷与 diagnostics.core，而契约要求它是 string ——
   * 缺了它，strict 模式下 diagnostics.core 整个方法失败（真实故障）。
   */
  readonly engineVersion?: string
}

/** 生产入口。omp 的隔离、设置、注册表与全部端口都在这一步建好（12 页 §6.1） */
export async function createOmpEngine(o: CreateOmpEngineOptions): Promise<AgentEngine> {
  return await createOmpEngineWith({ ...o, engineVersion: o.engineVersion ?? OMP_VERSION }, null)
}
