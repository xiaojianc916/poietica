/*
 * 桥与 Rust 之间的线上形状。
 *
 * 这是我们自己的协议，不是 omp 的 RPC 模式：omp 没有 kap 那样的增量 transcript
 * 通道，而屏幕经过必须走 transcript（AGENTS.md §2）。桥订阅 SDK 的 typed event，
 * 投影成 packages/transcript 已经钉住的 ops/reset，与命令应答同走一条 stdout。
 *
 * 判别式与字段都用 camelCase：Rust 侧 serde 直接对，不做第二套命名。
 */

/** Rust → 桥。一行一条，id 由 Rust 签发，应答原样回。 */
export type BridgeCommand =
  | { readonly id: string; readonly type: 'new_session'; readonly cwd: string }
  | { readonly id: string; readonly type: 'load_session'; readonly sessionId: string }
  | {
      readonly id: string
      readonly type: 'prompt'
      readonly text: string
      /** 磁盘绝对路径：字节不进协议，omp 自己按路径读。 */
      readonly attachments: readonly string[]
      readonly skills: readonly { readonly name: string; readonly args?: string }[]
    }
  | { readonly id: string; readonly type: 'cancel' }
  | { readonly id: string; readonly type: 'steer'; readonly text: string }
  /** 回答一次工具授权。decision 与 scope 是产品那三颗按钮的取值域。 */
  | {
      readonly id: string
      readonly type: 'answer_permission'
      readonly requestId: string
      readonly decision: 'approved' | 'rejected' | 'cancelled'
      readonly scope?: 'session'
    }
  /**
   * 回答任意一个对话框（上游 extension_ui_response 的四种）。
   *
   * 授权走 answer_permission（产品只有三颗按钮，语义比上游四档窄）；这一条是
   * 给别的对话框用的（ask 工具的题目、confirm、input），原样转发上游的响应形状。
   */
  | {
      readonly id: string
      readonly type: 'answer_dialog'
      readonly requestId: string
      readonly response: unknown
    }
  | { readonly id: string; readonly type: 'selectors' }
  | {
      readonly id: string
      readonly type: 'select'
      readonly configId: string
      readonly value: string
    }
  /** 目标模式此刻的事实；`data.goal` 为 null 就是这条会话没有目标。 */
  | { readonly id: string; readonly type: 'goal' }
  /** 屏幕经过的一页：打开一条会话时的基线。 */
  | {
      readonly id: string
      readonly type: 'transcript'
      readonly sessionId: string
      readonly agentId: string
      readonly beforeTurn: string | null
    }
  /** 从某个水位起的增量。 */
  | {
      readonly id: string
      readonly type: 'transcript_ops'
      readonly sessionId: string
      readonly agentId: string
      readonly sinceSeq: number
    }
  | { readonly id: string; readonly type: 'sessions' }
  | { readonly id: string; readonly type: 'skills' }
  | { readonly id: string; readonly type: 'mcp_servers' }
  /**
   * 模型目录的一次读或一次改。
   *
   * 读返回 providers / models / catalog / defaultModel；改接 setDefault 与
   * provider 的增删改（写进 agent 自己的 models.yml 与 config.yml）。
   */
  | {
      readonly id: string
      readonly type: 'model_catalog'
      readonly operation: ModelCatalogOperation
    }
  | { readonly id: string; readonly type: 'shutdown' }

/*
 * 一次 provider 输入；与 crates/agent-client 的 ProviderInput 逐字对应。
 *
 * 可缺席的格一律写成 `?: T | null`：这份形状是从 Rust 那条 JSON 线上解出来的，
 * Rust 的 `Option::None` 到这边是 `null`，不是 `undefined`。只写 `undefined` 会让
 * 下游误以为 `x === undefined` 就够判缺席 —— 那正是「null is not an object」的来源。
 */
export interface ProviderInput {
  readonly id: string
  readonly providerType: string
  readonly apiKey?: string | null
  readonly baseUrl?: string | null
  readonly defaultModel?: string | null
  readonly models: readonly ProviderModelInput[]
}

export interface ProviderModelInput {
  readonly model: string
  readonly maxContextSize: number
  readonly displayName?: string | null
  readonly capabilities?: readonly string[] | null
  readonly maxOutputSize?: number | null
  readonly supportEfforts?: readonly string[] | null
  readonly adaptiveThinking?: boolean | null
}

export interface ProviderReplacement extends Omit<ProviderInput, 'id'> {
  readonly newId?: string | null
}

/** 与 crates/agent-client 的 ModelCatalogOperation 逐字对应。 */
export type ModelCatalogOperation =
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'refreshProviders' }
  | { readonly kind: 'setDefault'; readonly modelId: string }
  /** 给一个 provider 配一把钥匙；落 agent 自己的凭据库（agent.db）。 */
  | { readonly kind: 'setApiKey'; readonly provider: string; readonly apiKey: string }
  /** 删一个 provider：钥匙从 agent.db 删，定义从 models.yml 删，provider 停用。 */
  | { readonly kind: 'delete'; readonly providerId: string }
  /** 建一个 provider；定义写 agent 自己的 models.yml。 */
  | { readonly kind: 'create'; readonly provider: ProviderInput }
  /** 整份换掉一个 provider；`newId` 给了就是改名。 */
  | {
      readonly kind: 'replace'
      readonly providerId: string
      readonly provider: ProviderReplacement
    }
  /**
   * 从 agent 自己的内置目录添加一个 provider。
   *
   * 目录里那一行已经带着 baseUrl / api / 模型清单，所以只有改端点（`baseUrl`）或
   * 改 id（`id`）时才写 models.yml；原样添加只写钥匙并解除停用。
   */
  | {
      readonly kind: 'importCatalog'
      readonly catalogId: string
      readonly apiKey?: string | null
      readonly baseUrl?: string | null
      readonly id?: string | null
    }

export type BridgeCommandType = BridgeCommand['type']

/** 桥 → Rust。 */
export type BridgeFrame =
  | {
      readonly type: 'ready'
      /** 桥自己的协议版本，不是 omp 的。 */
      readonly protocolVersion: number
      readonly agentVersion: string
    }
  | { readonly type: 'response'; readonly id: string; readonly data?: unknown }
  | { readonly type: 'failed'; readonly id: string; readonly message: string }
  | { readonly type: 'event'; readonly event: BridgeEvent }

/** 桥主动推的事件；Rust 侧落成 SessionEvent。 */
export type BridgeEvent =
  /** transcript 的一批增量或一次整发；payload 就是线上 transcript 帧。 */
  | {
      readonly kind: 'transcript'
      readonly sessionId: string
      readonly payload: unknown
    }
  /**
   * 这一轮按 agent 自己的说法结束了。
   *
   * 单独报一条而不是让 Rust 去读 transcript ops 里的 turn 状态：那等于让通用层
   * 解析协议内部形状，是第二个判别点。轮终是本机账本要记的事实，由知道的人报。
   */
  | {
      readonly kind: 'turn_end'
      readonly sessionId: string
      readonly outcome: 'completed' | 'cancelled' | 'failed'
      readonly message?: string
    }
  /**
   * 这条会话此刻能改的选择器，以及此刻的目标。
   *
   * 目标与选择器同车：两者都是「此刻这条会话是什么样」，而目标会在一次工具调用
   * 里被 agent 自己改掉（`goal_updated`），分开报就会有两个到达时刻。
   */
  | {
      readonly kind: 'selectors'
      readonly sessionId: string
      readonly controls: readonly SelectorControl[]
      readonly goal: GoalSnapshot | null
    }
  /**
   * agent 要问一个对话框。
   *
   * `request` 是上游 RpcExtensionUIRequest 的原样形状（method 为 select / confirm /
   * input / editor / notify / …）。授权那一类（method=select 且选项是那四档）由
   * Rust 翻成产品的一问一答；其余原样交给宿主，本层不解释。
   */
  | {
      readonly kind: 'dialog_requested'
      readonly sessionId: string
      readonly request: unknown
    }
  /** 一次会话的用量快照。 */
  | {
      readonly kind: 'usage'
      readonly sessionId: string
      readonly usage: UsageSnapshot
    }

export interface SelectorControl {
  readonly id: string
  readonly purpose: 'model' | 'thinking' | 'permission' | 'mode' | 'other'
  readonly current: string
  readonly choices: readonly SelectorChoice[]
}

export interface SelectorChoice {
  readonly value: string
  readonly label: string
}

/**
 * 目标模式此刻的事实。
 *
 * 与 crates/agent-client 的 GoalSnapshot、以及桌面的 AgentGoal 逐字同形（camelCase），
 * 所以 Rust 侧 serde 直接对，不做第二套命名。
 *
 * `status` 已经是产品那四个词（active / paused / blocked / complete）：omp 自己的
 * `GoalStatus`（多 budget-limited 与 dropped 两档）在桥里折一次，通用层不认识它。
 */
export interface GoalSnapshot {
  readonly objective: string
  /** omp 的目标没有「完成判据」这一格，恒为 null，不编一个。 */
  readonly completionCriterion: string | null
  readonly status: string
  /** 同上：omp 不按目标记轮数，恒为 0。 */
  readonly turnsUsed: number
  readonly tokensUsed: number
  readonly wallClockMs: number
}

export interface UsageSnapshot {
  readonly used: number
  readonly size: number
  readonly inputOther: number
  readonly inputCacheRead: number
  readonly inputCacheCreation: number
}

export const BRIDGE_PROTOCOL_VERSION = 1

/** 单行上限；与 omp RPC 的物理帧上限同量级，超了就换 reset 整发。 */
export const MAX_FRAME_BYTES = 1024 * 1024
