import type { Clock, Logger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import type { SettingsScope } from './settings-access'

/**
 * 全局（进程级）的 omp 对象：root Settings、模型注册表、凭据存储、日志、时钟、数据布局。
 * 它是 OmpEngine、SessionFactory 与各端口的公共输入；各端口不依赖 OmpEngine 本身（12 页 §10）。
 *
 * 这里的每个成员都是**最小形状**：字段与真实 omp 对象逐条核对过（见 docs/omp-sdk-reference.md 的
 * A.2-A.5），只留端口用得到的那几格。真实类型对不上时以 node_modules 的 .d.ts 为准。
 */
export interface OmpRuntime {
  readonly layout: DataLayout
  readonly logger: Logger
  readonly clock: Clock
  readonly aplicationVersion: string
  readonly root: SettingsScope
  /** omp 的 ModelRegistry 实例（config/model-registry.ts） */
  readonly registry: OmpModelRegistry
  /** omp 的 AuthStorage 实例（session/auth-storage.ts，实体在 @oh-my-pi/pi-ai） */
  readonly authStorage: OmpAuthStorage
  /** 本进程的 browser-relay 端口（browserRelayUrl 覆盖层用） */
  readonly relayPort: number
  /** 活着的会话（MCP 状态需要汇总它们） */
  readonly sessions: Set<OmpSessionLike>
}

export function markOmpContextScaffold(): void {
  // 占位函数：让本文件在端口实现落地前也能单独通过类型检查
}

// —— omp 的类型别名收在一处：端口实现只 import 本文件，不直接碰 omp 的深层类型 ——

/** omp 的 ModelRegistry 里端口用得着的成员（签名照 dist/types/config/model-registry.d.ts）。 */
export interface OmpModelRegistry {
  getAll(kind?: string): readonly OmpModel[]
  getAvailable(kind?: string): readonly OmpModel[]
  /** 两参：provider 与 model id（没有一参的 selector 形态） */
  find(provider: string, modelId: string): OmpModel | undefined
  hasConfiguredAuth(model: OmpModel): boolean
  hydrateCredentialScopedModelCaches(): Promise<void>
  refreshInBackground(strategy?: string): void
}

/**
 * omp 的一条模型里我们读的那几格。真实类型是 @oh-my-pi/pi-catalog 的 Model；
 * 没有 vision 那一格，视觉看的是 input 里有没有 'image'。
 */
export interface OmpModel {
  readonly provider: string
  readonly id: string
  readonly name?: string
  readonly reasoning?: boolean
  readonly contextWindow?: number | null
  readonly input?: readonly string[]
  /**
   * omp 的思考档位配置（`@oh-my-pi/pi-catalog` 的 ThinkingConfig）。
   *
   * `efforts` 是**静态**的 —— 它烤在模型目录里，不需要开会话就能拿到，所以入口页那排
   * 选择器的档位轨道可以不开会话就画出来（方案 §04 的 draftControls 正是靠它）。
   * 没有可控档位面的模型这一格是 `undefined`（不是空数组）。
   */
  readonly thinking?: { readonly efforts?: readonly string[]; readonly defaultLevel?: string } | undefined
}

/** omp 的 AuthStorage：credentials 子 API 是端口唯一写凭据的地方（omp 知识 #12）。 */
export interface OmpAuthStorage {
  readonly credentials: {
    has(provider: string): boolean
    get(provider: string): { type: string; key?: string } | undefined
    /** 写一把钥匙（异步：真身落在 agent.db） */
    set(provider: string, value: { type: 'api_key'; key: string; source: string }): Promise<void>
    remove(provider: string): Promise<void>
  }
}

/** 端口只需知道会话的这几件事（避免端口 ↔ 会话的循环依赖） */
export interface OmpSessionLike {
  readonly sessionId: string
  readonly sessionKey: string
  /** 该会话的 MCP 管理器（没有 MCP 时为 undefined） */
  readonly mcpManager: OmpMcpManager | undefined
}

/**
 * omp 的 MCPManager（mcp/manager.ts）里端口用得着的那几格。
 * 没有 getServerStatus 这一个批量方法，状态要按名字逐个问（getConnectionStatus / getConnection）。
 */
export interface OmpMcpManager {
  getAllServerNames?(): string[]
  getConnectionStatus?(name: string): string
  getConnection?(name: string): { tools?: readonly unknown[] } | undefined
  /** 假想中的批量接口：omp 18.5.0 没有，留着只为兼容别的实现 */
  getServerStatus?(): readonly { name: string; state: string; toolCount?: number; error?: string }[]
}
