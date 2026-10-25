/*
 * omp 的类型别名收在一处：端口实现只 import 本文件，不直接碰 omp 的深层类型。
 *
 * 这里的每个成员都是**最小形状**：字段与真实 omp 对象逐条核对过（见 docs/omp-sdk-reference.md 的
 * A.2-A.5），只留端口用得到的那几格。真实类型对不上时以 node_modules 的 .d.ts 为准。
 */

/** omp 的 ModelRegistry 里端口用得着的成员（签名照 dist/types/config/model-registry.d.ts）。 */
export interface OmpModelRegistry {
  getAll(kind?: string): readonly OmpModel[]
  getAvailable(kind?: string): readonly OmpModel[]
  /** 两参：provider 与 model id（没有一参的 selector 形态） */
  find(provider: string, modelId: string): OmpModel | undefined
  hasConfiguredAuth(model: OmpModel): boolean
  hydrateCredentialScopedModelCaches(): Promise<void>
  /**
   * 按 models.yml 的 mtime 决定要不要重读（omp 知识 #18：**没有** `reload()` 这个方法，
   * 旧代码的 `registry.reload?.()` 每次都静默落到 undefined，写完的 provider 要等下次启动才被认到）。
   */
  refreshIfStale(): Promise<boolean>
  refreshInBackground(strategy?: string): void
  /** 只刷一家（omp rpc-mode 登录成功后用的那一条：新凭据要重跑这家的模型发现，不复用缓存） */
  refreshProvider(providerId: string, strategy?: 'online' | 'offline'): Promise<void>
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
   * 选择器的档位轨道可以不开会话就画出来（draftControls 正是靠它）。
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

/**
 * omp 的 MCPManager（mcp/manager.ts）里端口用得着的那几格。
 * 它只有逐个名字问的三件（getAllServerNames / getConnectionStatus / getConnection），没有批量状态接口。
 */
export interface OmpMcpManager {
  getAllServerNames?(): string[]
  getConnectionStatus?(name: string): string
  getConnection?(name: string): { tools?: readonly unknown[] } | undefined
}
