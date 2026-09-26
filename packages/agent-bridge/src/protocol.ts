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
  /**
   * 重装一条以前开过的会话。`cwd` 是这条对话记下的工作区；应答是
   * `{sessionId, controls}`，会话文件已经不在了就回 `{sessionId: null}`。
   */
  | {
      readonly id: string
      readonly type: 'load_session'
      readonly sessionId: string
      readonly cwd: string
    }
  | {
      readonly id: string
      readonly type: 'prompt'
      readonly text: string
      readonly promptId: string
      /** 磁盘绝对路径：字节不进协议，omp 自己按路径读。 */
      readonly attachments: readonly string[]
      readonly skills: readonly { readonly name: string; readonly args?: string }[]
    }
  | { readonly id: string; readonly type: 'cancel' }
  | { readonly id: string; readonly type: 'steer'; readonly text: string }
  /**
   * 从某一轮分叉出一条新会话：丢掉末尾 `dropTurns` 轮，从更早那一点另起一条。
   *
   * 上游的原语是 `AgentSession#branch(entryId)`（它调 `createBranchedSession` 再重锚），
   * 不是 `SessionManager#fork()` —— 后者整份复制、一轮都不丢，做不出这个契约。
   * `dropTurns === 0` 才走整份复制。
   */
  | {
      readonly id: string
      readonly type: 'fork_session'
      readonly sessionId: string
      readonly dropTurns: number
    }
  /** 删掉一条会话文件与其产物目录；不存在的会话按失败回，不假装删掉了。 */
  | { readonly id: string; readonly type: 'delete_session'; readonly sessionId: string }
  /** 把一条会话导成一份自包含的 HTML，落点是绝对路径。 */
  | {
      readonly id: string
      readonly type: 'export_session'
      readonly sessionId: string
      readonly destination: string
    }
  /** 回答一次工具授权。decision 与 scope 是产品那三颗按钮的取值域。 */
  | {
      readonly id: string
      readonly type: 'answer_permission'
      readonly requestId: string
      readonly decision: 'approved' | 'rejected' | 'cancelled'
      readonly scope?: 'session'
    }
  /**
   * 回答一个对话框。
   *
   * 授权走 answer_permission（产品只有三颗按钮，语义比上游窄）；这一条给别的对话框用，
   * 两种载荷各自分明：
   * - **题组**（`questions_asked` 那一种）：`response` 是产品形状的答复
   *   （`{answers: {题号: {kind,…}}, method?, note?}`），由桥折回上游要的 results；
   *   空答案表就是「撤下整组」；
   * - 其余（confirm / input / editor）：原样转发上游的响应形状。
   *
   * 判据是「这个号是不是一组还在等的题」，不是载荷长什么样。
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
      /**
       * 与这次改动一起交上去的一段文字（目标那一格用它当 objective）。
       *
       * 可缺席，**且只对认它的那一格有意义** —— 别的选择器忽略它，不是把它塞进
       * value。Rust 的 Option::None 到这边是 null，所以写成 `?: string | null`。
       */
      readonly input?: string | null
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
  | { readonly id: string; readonly type: 'capabilities' }
  /** 读 agent 的浏览器控制设置。 */
  | { readonly id: string; readonly type: 'browser_settings' }
  /**
   * 写 agent 的浏览器控制设置；缺席的格不改。`cdpUrl` 给空串即清掉
   * （回到托管启动），给了地址就是附着到那个 CDP 端点而不是自己拉浏览器。
   */
  | {
      readonly id: string
      readonly type: 'set_browser_settings'
      readonly enabled?: boolean
      readonly headless?: boolean
      readonly cdpUrl?: string
    }
  | { readonly id: string; readonly type: 'skills' }
  | { readonly id: string; readonly type: 'mcp_servers' }
  /**
   * agent 自己的设置目录。
   *
   * 逐格从 omp 的 settings-schema 读出来（label / description / 类型 / 选项 / 默认值
   * 都是它自报的），我们不抄一份 —— 抄一份就是第二个事实，升级即分叉。
   *
   * `secret` 为真的那几格**只报有没有值**，绝不报值本身：那是钥匙，
   * 出了 agent 的进程就不再是我们的盘（AGENTS.md §1「密钥永不落我们的盘」）。
   */
  | { readonly id: string; readonly type: 'settings_catalog'; readonly tab?: string | null }
  /**
   * 改 agent 自己的一个设置。
   *
   * 走它自己的持久层（Settings.set + flush），由它自己热重载 —— 不手搓 config.yml。
   */
  | {
      readonly id: string
      readonly type: 'set_setting'
      readonly path: string
      readonly value: unknown
    }
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
  /**
   * agent 的 ask 工具在等人答一组题。
   *
   * `questions` 已经是**产品形状**（与 packages/conversation 的 QuestionItem 同形）：
   * omp 自己那份载荷（选项只有标签、没有号，还有 preview / recommended 这些我们画不出的
   * 字段）在桥里折过一次，因为「omp 的题长什么样」是 agent 专属知识（AGENTS.md §4）。
   * 号也由桥签发 —— 下方答案按同一个号回来。
   *
   * 答复走既有的 `answer_dialog` 命令，不新开一条：那是同一条路的两端。
   */
  | {
      readonly kind: 'questions_asked'
      readonly sessionId: string
      readonly requestId: string
      readonly questions: readonly AskedQuestion[]
    }

export interface SelectorControl {
  readonly id: string
  /** 这一格在人面前叫什么；缺席时原生侧退回用 id 当名字。 */
  readonly label?: string
  readonly purpose: 'model' | 'thinking' | 'permission' | 'mode' | 'other'
  readonly current: string
  readonly choices: readonly SelectorChoice[]
}

export interface SelectorChoice {
  readonly value: string
  readonly label: string
  /** 这一档的说明；缺席即没有话要说。与 crates/agent-client 的 ConfigChoice 同形。 */
  readonly detail?: string
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

/**
 * 一道等答的题，产品形状。
 *
 * 与 packages/conversation 的 QuestionItem 逐字同形，但少三格：`body`（omp 没有）、
 * `otherLabel` / `otherDescription`（omp 的「Other」是自己固定的那一句，不是题给的）。
 * 投影层 absent 即退回它自己的默认文案，所以这里如实缺席而不是编一句。
 *
 * `options[].id` 是桥现编的：omp 的选项只有标签。答案按号回来，所以号必须在桥这一侧
 * 与标签对上 —— 那是答案能被翻译回 omp 的唯一依据。
 */
export interface AskedQuestion {
  readonly id: string
  readonly question: string
  /** 题上方的短标签。omp 可缺席。 */
  readonly header?: string
  readonly options: readonly AskedQuestionOption[]
  readonly multiSelect: boolean
  /** omp 的 ask 恒定允许自答（tools/ask.ts 的 OTHER_OPTION），所以恒 true。 */
  readonly allowOther: boolean
}

export interface AskedQuestionOption {
  /** 桥签发的号；答案按它回来。 */
  readonly id: string
  readonly label: string
  readonly description?: string
}

/**
 * agent 自己那一格设置的说明书。
 *
 * 全部字段都是 omp 的 settings-schema 自报的，不是我们抄的：`label` / `description`
 * 由它给（我们只负责画），`options` 是它自己那张选项表。升级 omp 时这一份跟着变，
 * 我们没有需要同步的第二份。
 */
export interface SettingEntry {
  readonly path: string
  readonly type: string
  readonly label: string
  readonly description: string
  /** 所在的那一栏；我们的界面按它分组。 */
  readonly tab: string
  /** 所在的那一节。 */
  readonly group?: string
  /** 未设置时生效的值；界面用它做「默认」提示。 */
  readonly default: unknown
  /** 此刻生效的值；`secret` 为真时恒为 null（值不出 agent 的进程）。 */
  readonly value: unknown
  /** 是不是钥匙。为真时 `value` 恒为 null，只有 `hasValue` 说话。 */
  readonly secret: boolean
  /** 钥匙有没有配过；非钥匙恒为 false。 */
  readonly hasValue: boolean
  /** 枚举/子菜单那张选项表；缺席即这一格没有固定选项。 */
  readonly options?: readonly SettingOption[]
  /** 枚举的取值域，给没有 options 的那些用。 */
  readonly enumValues?: readonly string[]
  /** 风险提示（会把用户拉进限流或被封的那类设置）。 */
  readonly warning?: string
  /**
   * 可见性条件名（omp 自己的写法，如 `advisorEnabled`）。
   *
   * 只有名字，不是判据：求值要用**此刻的设置**，那是界面这一侧的事，
   * 我们不把一张条件表从 agent 的进程搬到这儿。
   */
  readonly condition?: string
  /**
   * 所在分节的中文名。
   *
   * 分组仍然按 `group`（agent 自己的词）分：键不能译，译了同一节会分裂成两节。
   * 落在这里的只是给人看的那一列。
   */
  readonly groupLabel?: string
  /**
   * 这一格的**行**由产品别处的控件负责（输入框那一排的选择器、设置页的浏览器一节）。
   *
   * 值仍然要报：别的格子按 `condition` 读它的 value 决定显不显示。界面据此只跳过这一行，
   * 不跳过它的值。一个事实两个控件是缺陷（AGENTS.md §1），但把值一起抽掉会让依赖它的
   * 那几行永远消失，而屏幕上没有任何迹象 —— 那比重复控件更难发现。
   */
  readonly owned?: boolean
}

export interface SettingOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

export interface SettingsTab {
  /** agent 自己的栏目键；筛选与分组都认它，不译。 */
  readonly key: string
  /** 给人看的名字。 */
  readonly label: string
}

/**
 * 设置目录 + 它背后那份配置文件。
 *
 * 带上配置文件路径是因为「几百项设置」这件事有个更省事的出路：直接改 agent 自己的
 * 配置文件。路径不由界面拼 —— 正本是 agent 自己的 getAgentDir()，拼一份就是第二个
 * 事实，换个 home 就分叉。
 */
export interface SettingsCatalog {
  /**
   * 栏目清单，按 agent 自己的顺序。
   *
   * 键与名成对给，不给两条并行数组：并行数组一旦错位就是「点了外观出来模型」，而这里
   * 没有一种读法能发现它错了。
   */
  readonly tabs: readonly SettingsTab[]
  readonly settings: readonly SettingEntry[]
  /** agent 此刻在用的配置文件绝对路径（config.yml）。 */
  readonly configFile: string
  /** 那份文件此刻在不在；不在就是 agent 还没写过。 */
  readonly configFileExists: boolean
}

export const BRIDGE_PROTOCOL_VERSION = 2

/** 单行上限；与 omp RPC 的物理帧上限同量级，超了就换 reset 整发。 */
export const MAX_FRAME_BYTES = 1024 * 1024
