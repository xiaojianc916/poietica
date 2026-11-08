import type { Contract } from '@poietica/contract-kit'
import type { AgentEngine } from '@poietica/engine'
import type { Clock, DisposableStore, Logger, ModuleServices } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import type { Migration, ModuleDatabase } from '@poietica/storage-sqlite'
import type { AgentToolRegistry } from './agent-tools'
import type { CoreEventBus } from './events'
import type { CoreRpcBinding, HostCaller } from './rpc-binding'

export interface CoreModule<C extends Contract = Contract> {
  /** 等于功能 id（kebab-case）。 */
  readonly id: string
  readonly contract?: C
  readonly dependsOn?: readonly string[]
  /** 表结构迁移；表名、索引名必须以 `${表前缀}_` 开头（表前缀 = id 中的 '-' 换成 '_'）。 */
  readonly migrations?: readonly Migration[]
  setup(ctx: CoreModuleContext<C>): void | Promise<void>
}

/**
 * 数据库的打开方式（ADR-004）。只读有两种来路：库来自更新的 Poietica（降级安装），或者迁移失败
 * （整批事务已回滚，库还是升级前的样子）。只读时任何写入都会以 `kernel.data_read_only` 失败。
 */
export type CoreDataMode =
  { readonly mode: 'readWrite' } | { readonly mode: 'readOnly'; readonly reason: 'data_too_new' | 'migration_failed' }

/** 已从产品移除的模块：内核清掉它的表，并在第一次清理后跑一次 cleanup */
export interface RetiredCoreModule {
  readonly id: string
  /** 移除它的决策记录（ADR 编号，写进日志用） */
  readonly adr: string
  cleanup?(ctx: { readonly engine: AgentEngine; readonly logger: Logger }): Promise<void>
}

/** 进程级信息与控制：只有 platform 的 diagnostics 用得到 */
export interface CoreRuntimeInfo {
  readonly coreVersion: string
  readonly engineVersion: string
  readonly dataMode: CoreDataMode
  /** 启动时从环境中清掉的变量名（只有名字，没有值） */
  readonly scrubbedEnvKeys: readonly string[]
  setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void
}

export interface CoreModuleContext<C extends Contract = Contract> {
  readonly moduleId: string
  readonly logger: Logger
  readonly clock: Clock
  readonly layout: DataLayout
  readonly db: ModuleDatabase
  /** 引擎端口；注册 agent 工具走 ctx.agentTools（内核在全部 setup 之后冻结工具表）。 */
  readonly engine: AgentEngine
  readonly rpc: CoreRpcBinding<C>
  readonly host: HostCaller
  readonly services: ModuleServices
  readonly events: CoreEventBus
  readonly agentTools: AgentToolRegistry
  readonly runtime: CoreRuntimeInfo
  readonly lifecycle: {
    onReady(fn: () => void | Promise<void>): void
    onShutdown(fn: () => void | Promise<void>): void
  }
  readonly disposables: DisposableStore
}

export function defineCoreModule<C extends Contract>(m: CoreModule<C>): CoreModule<C> {
  return m
}
